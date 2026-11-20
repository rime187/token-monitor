// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { listAccounts, readActiveAccount } = require('./auth');
const { cursorCacheDir } = require('./usageEvents');
const { withCursorLifecycle } = require('./lifecycle');
const { readCursorWebIdentity } = require('./probe');
const { readUsageJson } = require('./webUsageResponse');
const { fetchCursorBillingEvents } = require('./billingUsage');

const EVENTS_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
const PAGE_SIZE = 500;
const MAX_EVENTS = 250_000;
const MAX_BYTES = 64 * 1024 * 1024;

/** @typedef {{timestamp: string | number, model?:string, conversationId?:string, usageEventId?:string, tokenUsage?:Record<string, number | string>}} UsageEvent */
/** @param {UsageEvent} row */
function eventKey(row) {
  if (row.usageEventId) return row.usageEventId;
  return JSON.stringify([Number(row.timestamp), row.model?.trim() || '', row.conversationId?.trim() || '',
    ...['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .map(key => Number(row.tokenUsage?.[key]) || 0)]);
}

// Keep the complete incoming multiset. Two anonymous events can have the same
// counters; a repeated download must preserve their multiplicity exactly.
/** @param {UsageEvent[]} previous @param {UsageEvent[]} incoming */
function mergeEvents(previous, incoming) {
  const replaced = new Set(incoming.map(eventKey));
  return incoming.concat(previous.filter(event => !replaced.has(eventKey(event))));
}

/** @param {string} dir @returns {string[]} */
function liveFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => /^usage(?:\.[^.].*)?\.(?:csv|json)$/.test(name) && !name.startsWith('usage.backup')); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
}

/** @param {string} file */
function fileVersion(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('Cursor usage cache is not a regular file');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

/** @typedef {{since:number, through:number}} BillingCoverage */
/** @param {string} file @param {string} accountId @param {UsageEvent[]} events @param {BillingCoverage|null} billing */
function writeSnapshot(file, accountId, events, billing) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      _tokscale: { version: 1, accountId, ...(billing && { billing }) }, totalUsageEventsCount: events.length, usageEventsDisplay: events
    }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** @param {typeof fetch} fetchWeb @param {number} start @param {number} end @param {AbortSignal} signal */
async function fetchEvents(fetchWeb, start, end, signal) {
  /** @type {UsageEvent[]} */
  const events = [];
  let bytes = 0;
  let total = null;
  for (let page = 1; page <= 5000; page++) {
    const res = await fetchWeb(EVENTS_URL, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: String(start), endDate: String(end), page, pageSize: PAGE_SIZE })
    });
    if (!res.ok) throw new Error(`Cursor usage HTTP ${res.status}`);
    const result = await readUsageJson(res, MAX_BYTES - bytes);
    bytes += result.bytes;
    const json = result.json;
    // Unified personal accounts can answer the legacy first page with {}.
    // Only a complete read of their billing ledger can establish zero usage.
    if (page === 1 && json && typeof json === 'object' && !Array.isArray(json) && !Object.keys(json).length) return null;
    const rows = json?.usageEventsDisplay;
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid Cursor usage events response');
    }
    if (events.length + rows.length > MAX_EVENTS) throw new Error('Cursor usage exceeds the supported event count');
    let crossedStart = false;
    for (const row of rows) {
      const timestamp = Number(row.timestamp);
      if (start && row.model && timestamp > 0 && timestamp < start) crossedStart = true;
      else events.push(row);
    }
    // The dashboard sorts newest first. Some responses ignore startDate and
    // advertise the full historical total even on an incremental request.
    if (crossedStart) return events;
    if (total === null && json.totalUsageEventsCount != null) total = Number(json.totalUsageEventsCount);
    if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error('Invalid Cursor usage count');
    if (total !== null && events.length >= total) return events;
    if (!rows.length) {
      if (total !== null) throw new Error('Cursor returned incomplete usage history');
      return events;
    }
    // If no total was announced, request the next page even on a short page.
    // Cursor sometimes serves 100 rows although the request asked for 500.
  }
  throw new Error('Cursor usage pagination did not complete');
}

/**
 * Uses the verified web account's existing Tokscale cache when it also has
 * a native login. Web-only files live one level below the CLI-managed files:
 * Tokscale reports scan this directory, while CLI login/logout ignore it.
 * @param {typeof fetch} fetchWeb
 * @param {{accountId:string, signal?:AbortSignal, allTimeSince?:string, home?:string, cacheDir?:string}} options
 */
async function syncCursorWebUsage(fetchWeb, { accountId, signal, allTimeSince, home, cacheDir = cursorCacheDir({ homeDir: home }) }) {
  const deadline = AbortSignal.timeout(1_830_000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function checkAccount() {
    const check = await readCursorWebIdentity(fetchWeb, { signal: active });
    if (!check.ok) throw new Error(check.error.message);
    if (check.account.id !== accountId) throw new Error('Cursor web account changed. Reconnect to sync this account.');
    return check.createdAtMs;
  }
  return withCursorLifecycle(async () => {
    const createdAtMs = await checkAccount();
    const hash = createHash('sha256').update(accountId).digest('hex');
    const name = `usage.account-${hash}.json`;
    const webFile = path.join(cacheDir, 'web', name);
    const saved = listAccounts({ home }).some(account => account?.id === accountId);
    const target = saved ? path.join(cacheDir, readActiveAccount({ home })?.id === accountId ? 'usage.json' : name) : webFile;
    const files = liveFiles(cacheDir);
    // The scanner ignores archive/ and prefers a JSON file to its CSV sibling.
    // A bare CSV/legacy JSON has no provable owner: adding web data beside it
    // could bill the same account twice. Let native sync migrate it first.
    const ambiguous = 'Cursor has an unverified legacy usage cache. Sync the existing Cursor account before importing web usage.';
    if (files.some(file => file.endsWith('.csv') && !files.includes(file.slice(0, -4) + '.json'))) throw new Error(ambiguous);
    const candidates = files.filter(file => file.endsWith('.json')).map(file => path.join(cacheDir, file));
    if (fs.existsSync(webFile)) candidates.push(webFile);
    const sources = new Map();
    /** @type {BillingCoverage|null} */
    let coverage = null;
    /** @type {UsageEvent[]} */
    let previous = [];
    for (const file of candidates) {
      const version = fileVersion(file);
      const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof cache?._tokscale?.accountId !== 'string') throw new Error(ambiguous);
      if (cache._tokscale.accountId !== accountId) {
        if (file === target) throw new Error('Cursor active account cache is changing. Existing usage was kept.');
        continue;
      }
      if (!Array.isArray(cache.usageEventsDisplay)) throw new Error('Invalid Cursor usage cache');
      const billing = cache._tokscale.billing;
      if (Number.isSafeInteger(billing?.since) && Number.isSafeInteger(billing?.through) &&
          billing.since >= 0 && billing.since <= billing.through && billing.through <= Date.now()) coverage = billing;
      sources.set(file, version);
      previous = mergeEvents(previous, cache.usageEventsDisplay);
    }
    const end = Date.now();
    const latest = previous.reduce((max, row) => {
      const t = Number(row.timestamp);
      return row.model && t > max && t <= end ? t : max;
    }, 0);
    // Match the native importer's one-hour overlap for late billing corrections.
    let start = Math.max(0, latest - 3_600_000);
    let incoming = coverage ? null : await fetchEvents(fetchWeb, start, end, active);
    let billing = null;
    if (incoming === null) {
      const configured = Date.parse(`${allTimeSince}T00:00:00`);
      if (!Number.isFinite(configured) || configured < 0 || configured >= end) throw new Error('Invalid Cursor billing history start date');
      const since = createdAtMs !== undefined && createdAtMs <= end ? Math.max(configured, createdAtMs) : configured;
      start = sources.size === 1 && coverage && coverage.since <= since ? Math.max(since, coverage.through - 3_600_000) : since;
      incoming = await fetchCursorBillingEvents(fetchWeb, { start, end, signal: active });
      // Persist a daily checkpoint even for an empty account, atomically with its
      // rows. Repeat the current day and its overlap for late billing updates.
      billing = { since, through: Math.max(since, Math.floor(end / 86_400_000) * 86_400_000) };
    }
    await checkAccount();
    active.throwIfAborted();
    // A completely fetched time window is authoritative, including corrected
    // anonymous events and voided charges that disappeared from the dashboard.
    const older = previous.filter(row => {
      const t = Number(row.timestamp);
      return !Number.isFinite(t) || t < start || (billing ? t >= end : t > end);
    });
    const events = mergeEvents(older, incoming);
    const obsolete = [...sources.keys()].filter(file => file !== target);
    if (obsolete.some(file => fs.existsSync(file.slice(0, -5) + '.csv'))) throw new Error(ambiguous);
    if (sources.size === 0 || obsolete.length || coverage?.since !== billing?.since ||
        coverage?.through !== billing?.through || JSON.stringify(events) !== JSON.stringify(previous)) {
      if ((!sources.has(target) && fs.existsSync(target)) || [...sources].some(([file, version]) => fileVersion(file) !== version)) {
        throw new Error('Cursor usage cache changed during sync. Existing usage was kept.');
      }
      // Move the merged snapshot on adoption so two report-visible copies are
      // never installed by a successful migration. Other accounts are untouched.
      const from = obsolete.shift();
      writeSnapshot(from || target, accountId, events, billing);
      if (from) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.renameSync(from, target);
      }
      for (const duplicate of obsolete) fs.unlinkSync(duplicate);
    }
    return accountId;
  }, { signal: active });
}

module.exports = { syncCursorWebUsage };
