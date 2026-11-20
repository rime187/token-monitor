'use strict';

const https = require('node:https');
const { abortError, runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const AUTH_ME_URL = 'https://cursor.com/api/auth/me';
const REQUEST_USAGE_URL = 'https://cursor.com/api/usage';
const SAND_USAGE_URL = 'https://cursor.com/api/dashboard/get-sand-usage-status';
const PLAN_INFO_URL = 'https://cursor.com/api/dashboard/get-plan-info';
const PREPAID_BILLING_URL = 'https://cursor.com/api/dashboard/get-user-prepaid-billing';
const CURRENT_PERIOD_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const SAND_TIMEOUT_MS = 5000;

const DEFAULT_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://cursor.com/dashboard',
  'User-Agent': BROWSER_USER_AGENT
};

function clampPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function centsToUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(value) / 100;
}

function percentFromUsedLimit(used, limit) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

function hasAnyNumber(...values) {
  return values.some((value) => typeof value === 'number' && Number.isFinite(value));
}

function parseRequestUsage(input) {
  const usage = input && typeof input === 'object' ? input : {};
  const gpt4 = usage['gpt-4'] || usage.gpt4 || {};
  const requestsUsed = numberOrNull(gpt4.numRequestsTotal) ?? numberOrNull(gpt4.numRequests);
  const requestsLimit = numberOrNull(gpt4.maxRequestUsage);
  return {
    requestsUsed,
    requestsLimit
  };
}

function isoTimestampOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseGrokBotUsage(input) {
  const usage = input && typeof input === 'object' ? input : {};
  const usedPercent = clampPercent(numberOrNull(usage.usagePercent));
  const periodStart = isoTimestampOrNull(usage.currentPeriodStart);
  const resetsAt = isoTimestampOrNull(usage.nextResetTimestampUtc);
  const startMs = periodStart ? Date.parse(periodStart) : Number.NaN;
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const windowMinutes = Number.isFinite(startMs) && Number.isFinite(resetMs) && resetMs > startMs
    ? Math.round((resetMs - startMs) / 60000)
    : null;
  return {
    usedPercent,
    periodStart,
    resetsAt,
    windowMinutes,
    hasAvailableUsage: typeof usage.hasAvailableUsage === 'boolean' ? usage.hasAvailableUsage : null,
    hasNonZeroIncludedLimit: usage.hasNonZeroIncludedLimit === true,
    isUnified: usage.isUnified === true
  };
}

// Dashboard RPCs answer in proto3 JSON: int64 values arrive as decimal strings,
// enums as their full names, and zero values (false, 0, unspecified) are omitted.
function int64OrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function epochMsToIso(value) {
  const ms = int64OrNull(value);
  return ms === null || ms <= 0 ? null : isoTimestampOrNull(ms);
}

function parsePlanInfo(input) {
  const response = input && typeof input === 'object' ? input : {};
  const info = response.planInfo && typeof response.planInfo === 'object' ? response.planInfo : {};
  const period = info.includedUsagePeriod;
  return {
    isMerged: response.isMerged === true,
    planName: typeof info.planName === 'string' ? info.planName : null,
    includedUsagePeriod: period === 'INCLUDED_USAGE_PERIOD_WEEKLY'
      ? 'weekly'
      : period === 'INCLUDED_USAGE_PERIOD_MONTHLY' ? 'monthly' : null,
    includedUsageResetsAt: epochMsToIso(info.includedUsageResetsAt),
    billingCycleEnd: epochMsToIso(info.billingCycleEnd)
  };
}

function parsePrepaidBilling(input) {
  const response = input && typeof input === 'object' ? input : {};
  const availableCents = response.availableCents === undefined ? 0 : int64OrNull(response.availableCents);
  return {
    availableUsd: availableCents === null ? null : Math.max(0, availableCents) / 100
  };
}

function decimalOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Cursor settings reads this RPC. usage-summary can report an explicit 0 for a
// unified plan's monthly bucket while this weekly included percent is in use.
function parseCurrentPeriodUsage(input) {
  const response = input && typeof input === 'object' ? input : {};
  const plan = response.planUsage && typeof response.planUsage === 'object' ? response.planUsage : {};
  return {
    totalPercentUsed: clampPercent(decimalOrNull(plan.totalPercentUsed))
  };
}

function sessionAccessToken(sessionToken) {
  let token = String(sessionToken || '');
  try { token = decodeURIComponent(token); } catch (_) { return ''; }
  const separator = token.indexOf('::');
  if (separator < 0) return '';
  const accessToken = token.slice(separator + 2).trim();
  return accessToken.split('.').length === 3 ? accessToken : '';
}

// Current-period usage wins, including an explicit zero, then unified sand.
// Only explicitly monthly plans receive a usage-summary fallback.
function unifiedIncludedPercent(summaryPercent, periodPercent, sandPercent) {
  if (periodPercent !== null) return periodPercent;
  if (sandPercent !== null) return sandPercent;
  return summaryPercent;
}

function parseUsageSummary(input, { requestUsage = null, unifiedPlan = false } = {}) {
  const summary = input && typeof input === 'object' ? input : {};
  const individual = summary.individualUsage && typeof summary.individualUsage === 'object' ? summary.individualUsage : {};
  const plan = individual.plan && typeof individual.plan === 'object' ? individual.plan : {};
  const onDemand = individual.onDemand && typeof individual.onDemand === 'object' ? individual.onDemand : {};
  const overall = individual.overall && typeof individual.overall === 'object' ? individual.overall : {};
  const team = summary.teamUsage && typeof summary.teamUsage === 'object' ? summary.teamUsage : {};
  const teamOnDemand = team.onDemand && typeof team.onDemand === 'object' ? team.onDemand : {};
  const teamPooled = team.pooled && typeof team.pooled === 'object' ? team.pooled : {};
  const planUsed = numberOrNull(plan.used) ?? 0;
  const planLimit = numberOrNull(plan.limit) ?? 0;
  const overallUsed = numberOrNull(overall.used);
  const overallLimit = numberOrNull(overall.limit);
  const overallRemaining = numberOrNull(overall.remaining);
  const autoPercent = clampPercent(numberOrNull(plan.autoPercentUsed));
  const apiPercent = clampPercent(numberOrNull(plan.apiPercentUsed));
  const onDemandUsed = numberOrNull(onDemand.used) ?? 0;
  const onDemandLimit = numberOrNull(onDemand.limit);
  const onDemandRemaining = numberOrNull(onDemand.remaining);
  const teamOnDemandUsed = numberOrNull(teamOnDemand.used);
  const teamOnDemandLimit = numberOrNull(teamOnDemand.limit);
  const teamOnDemandRemaining = numberOrNull(teamOnDemand.remaining);
  const teamPooledUsed = numberOrNull(teamPooled.used);
  const teamPooledLimit = numberOrNull(teamPooled.limit);
  const teamPooledRemaining = numberOrNull(teamPooled.remaining);

  // Missing totals and counters stay unknown; model-pool percentages are separate.
  let planPercent = clampPercent(numberOrNull(plan.totalPercentUsed));
  if (planPercent === null) {
    if (planLimit > 0) planPercent = percentFromUsedLimit(numberOrNull(plan.used), planLimit);
    // Legacy aggregate pools do not establish a unified seat's included usage.
    else if (!unifiedPlan && overallLimit !== null && overallLimit > 0) planPercent = percentFromUsedLimit(overallUsed, overallLimit);
    else if (!unifiedPlan && teamPooledLimit !== null && teamPooledLimit > 0) planPercent = percentFromUsedLimit(teamPooledUsed, teamPooledLimit);
  }

  let resolvedPlanUsed = planUsed;
  let resolvedPlanLimit = planLimit;
  let resolvedPlanRemaining = plan.remaining === undefined ? null : numberOrNull(plan.remaining);
  if (resolvedPlanLimit <= 0 && resolvedPlanUsed <= 0) {
    if (overallUsed !== null && overallLimit !== null) {
      resolvedPlanUsed = overallUsed;
      resolvedPlanLimit = overallLimit;
      resolvedPlanRemaining = overallRemaining;
    } else if (teamPooledUsed !== null && teamPooledLimit !== null) {
      resolvedPlanUsed = teamPooledUsed;
      resolvedPlanLimit = teamPooledLimit;
      resolvedPlanRemaining = teamPooledRemaining;
    }
  }

  const parsedRequestUsage = parseRequestUsage(requestUsage);
  return {
    planPercent,
    autoPercent,
    apiPercent,
    planUsedUsd: centsToUsd(resolvedPlanUsed),
    planLimitUsd: centsToUsd(resolvedPlanLimit),
    planRemainingUsd: resolvedPlanRemaining === null ? null : centsToUsd(resolvedPlanRemaining),
    onDemandPercent: percentFromUsedLimit(onDemandUsed, onDemandLimit),
    onDemandUsedUsd: centsToUsd(onDemandUsed),
    onDemandLimitUsd: onDemandLimit === null ? null : centsToUsd(onDemandLimit),
    onDemandRemainingUsd: onDemandRemaining === null ? null : centsToUsd(onDemandRemaining),
    teamOnDemandPercent: percentFromUsedLimit(teamOnDemandUsed, teamOnDemandLimit),
    teamOnDemandUsedUsd: teamOnDemandUsed === null ? null : centsToUsd(teamOnDemandUsed),
    teamOnDemandLimitUsd: teamOnDemandLimit === null ? null : centsToUsd(teamOnDemandLimit),
    teamOnDemandRemainingUsd: teamOnDemandRemaining === null ? null : centsToUsd(teamOnDemandRemaining),
    teamPooledPercent: percentFromUsedLimit(teamPooledUsed, teamPooledLimit),
    teamPooledUsedUsd: teamPooledUsed === null ? null : centsToUsd(teamPooledUsed),
    teamPooledLimitUsd: teamPooledLimit === null ? null : centsToUsd(teamPooledLimit),
    teamPooledRemainingUsd: teamPooledRemaining === null ? null : centsToUsd(teamPooledRemaining),
    billingCycleEnd: typeof summary.billingCycleEnd === 'string' ? summary.billingCycleEnd : null,
    membershipType: typeof summary.membershipType === 'string' ? summary.membershipType : null,
    limitType: typeof summary.limitType === 'string' ? summary.limitType : null,
    isUnlimited: typeof summary.isUnlimited === 'boolean' ? summary.isUnlimited : false,
    hasPlanUsage: hasAnyNumber(plan.used, plan.limit, plan.remaining, plan.totalPercentUsed, plan.autoPercentUsed, plan.apiPercentUsed),
    hasOverallUsage: Boolean(overall && typeof overall === 'object' && hasAnyNumber(overall.used, overall.limit, overall.remaining)),
    hasOnDemandUsage: Boolean(onDemand && typeof onDemand === 'object' && hasAnyNumber(onDemand.used, onDemand.limit, onDemand.remaining)),
    hasTeamOnDemandUsage: Boolean(teamOnDemand && typeof teamOnDemand === 'object' && hasAnyNumber(teamOnDemand.used, teamOnDemand.limit, teamOnDemand.remaining)),
    hasTeamPooledUsage: Boolean(teamPooled && typeof teamPooled === 'object' && hasAnyNumber(teamPooled.used, teamPooled.limit, teamPooled.remaining)),
    ...parsedRequestUsage
  };
}

function parseUserInfo(input) {
  const info = input && typeof input === 'object' ? input : {};
  return {
    email: typeof info.email === 'string' ? info.email : null,
    name: typeof info.name === 'string' ? info.name : null,
    sub: typeof info.sub === 'string' ? info.sub : null
  };
}

function dashboardRpc(url, sessionToken, opts, configuredTimeoutMs) {
  return requestJson(url, sessionToken, {
    ...opts,
    timeoutMs: Math.min(configuredTimeoutMs, SAND_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://cursor.com'
    },
    body: '{}'
  });
}

function requestJson(url, sessionToken, {
  timeoutMs = 15000,
  httpsLib = https,
  signal,
  method = 'GET',
  headers = {},
  body = null,
  bearerToken = ''
} = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let settled = false;
    let req = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      const error = abortError(signal);
      try { req?.destroy?.(error); } catch (_) {}
      finish({ ok: false, error: { kind: 'network', message: error.message } });
    };
    req = httpsLib.request({
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        ...(bearerToken
          ? { Authorization: `Bearer ${bearerToken}` }
          : { Cookie: `WorkosCursorSessionToken=${sessionToken}` })
      }
    }, (res) => {
      // Short-circuit on auth failures so we don't depend on the response stream emitting 'end'.
      if (res.statusCode === 401 || res.statusCode === 403) {
        return finish({ ok: false, error: { kind: 'unauthorized', message: `HTTP ${res.statusCode}` } });
      }
      if (typeof res.statusCode !== 'number' || res.statusCode < 200 || res.statusCode >= 300) {
        return finish({ ok: false, error: { kind: 'network', message: `HTTP ${res.statusCode}` } });
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          finish({ ok: true, json: JSON.parse(body) });
        } catch (err) {
          finish({ ok: false, error: { kind: 'parse', message: err.message } });
        }
      });
      res.on('error', (err) => finish({ ok: false, error: { kind: 'network', message: err.message } }));
    });
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
    }
    req.on('error', (err) => finish({ ok: false, error: { kind: 'network', message: err.message } }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (body !== null && body !== undefined) req.write(String(body));
    req.end();
  });
}

async function probe(sessionToken, opts = {}) {
  if (!sessionToken) return { ok: false, error: { kind: 'unauthorized', message: 'no session token' } };
  const configuredTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000;
  const get = (url) => requestJson(url, sessionToken, opts);
  const rpc = (url) => dashboardRpc(url, sessionToken, opts, configuredTimeoutMs);
  const readPeriod = () => {
    const accessToken = sessionAccessToken(sessionToken);
    if (!accessToken) return null;
    const timeoutMs = Math.min(configuredTimeoutMs, SAND_TIMEOUT_MS);
    return runWithProbeDeadline(({ signal }) => requestJson(CURRENT_PERIOD_USAGE_URL, sessionToken, {
      ...opts, signal, timeoutMs, method: 'POST', body: '{}',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      bearerToken: accessToken
    }), { signal: opts.signal, deadlineMs: timeoutMs }).catch(() => null);
  };
  return probeDashboard(get, rpc, get(AUTH_ME_URL), readPeriod);
}

async function probeDashboard(get, rpc, identity, readPeriod) {
  // Grok Bot and plan info are best effort: neither may fail the account row.
  const [usageResult, userResult, grokBotResult, planInfoResult] = await Promise.all([
    get(USAGE_SUMMARY_URL), identity, rpc(SAND_USAGE_URL), rpc(PLAN_INFO_URL)
  ]);
  if (!usageResult.ok) return usageResult;
  const user = userResult.ok ? parseUserInfo(userResult.json) : { email: null, name: null, sub: null };
  let requestUsage = null;
  if (user.sub) {
    const url = `${REQUEST_USAGE_URL}?user=${encodeURIComponent(user.sub)}`;
    const requestUsageResult = await get(url);
    if (requestUsageResult.ok) requestUsage = requestUsageResult.json;
  }
  const grokBot = grokBotResult.ok ? parseGrokBotUsage(grokBotResult.json) : null;
  const planInfo = planInfoResult.ok ? parsePlanInfo(planInfoResult.json) : null;
  const unifiedPlan = planInfo ? planInfo.isMerged : grokBot?.isUnified === true;
  // Only unified (The X Subscription) plans carry a prepaid balance, so legacy
  // plans never pay for this request. Current-period usage is the included
  // percent Cursor settings shows; it is best effort and must not fail the row.
  let prepaid = null;
  let periodPercent = null;
  if (unifiedPlan) {
    const [prepaidResult, periodResult] = await Promise.all([
      rpc(PREPAID_BILLING_URL), readPeriod?.()
    ]);
    if (prepaidResult.ok) prepaid = parsePrepaidBilling(prepaidResult.json);
    if (periodResult?.ok) periodPercent = parseCurrentPeriodUsage(periodResult.json).totalPercentUsed;
  }
  const usage = { ...parseUsageSummary(usageResult.json, { requestUsage, unifiedPlan }), grokBot, planInfo, prepaid };
  if (unifiedPlan) {
    const sandPercent = grokBot?.isUnified === true ? grokBot.usedPercent : null;
    // The summary's monthly bucket cannot establish a weekly seat allowance.
    const summaryFallback = planInfo?.includedUsagePeriod === 'monthly' ? usage.planPercent : null;
    usage.planPercent = unifiedIncludedPercent(summaryFallback, periodPercent, sandPercent);
  }
  return { ok: true, usage, user };
}

async function requestWebJson(fetchWeb, url, { signal, timeoutMs = 15000 } = {}, post = false) {
  try {
    return await runWithProbeDeadline(async ({ signal: requestSignal }) => {
      const res = await fetchWeb(url, post ? {
        signal: requestSignal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      } : { signal: requestSignal });
      if (res.status === 204 && url === AUTH_ME_URL) {
        return { ok: false, error: { kind: 'unauthorized', message: 'No signed-in Cursor account' } };
      }
      if (!res.ok) {
        const kind = res.status === 401 || res.status === 403 ? 'unauthorized' : 'network';
        return { ok: false, error: { kind, message: `HTTP ${res.status}` } };
      }
      try { return { ok: true, json: await res.json() }; }
      catch (_) { return { ok: false, error: { kind: 'parse', message: 'Invalid Cursor dashboard response' } }; }
    }, { signal, deadlineMs: post ? Math.min(SAND_TIMEOUT_MS, timeoutMs) : timeoutMs });
  } catch (_) {
    if (signal?.aborted) throw abortError(signal);
    return { ok: false, error: { kind: 'network', message: 'Could not reach Cursor dashboard' } };
  }
}

function webIdentity(result) {
  if (!result.ok) return result;
  const { sub, email } = parseUserInfo(result.json);
  const id = /(?:^|\|)(user_[A-Za-z0-9_]+)$/.exec(sub || '')?.[1];
  if (!id) return { ok: false, error: { kind: 'unauthorized', message: 'No signed-in Cursor account' } };
  return { ok: true, account: { id, email: email || '' } };
}

async function readCursorWebIdentity(fetchWeb, opts = {}) {
  const reply = await requestWebJson(fetchWeb, AUTH_ME_URL, opts);
  const identity = webIdentity(reply);
  if (!identity.ok) return identity;
  const created = reply.json.created_at;
  const ms = typeof created === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(created) ? Date.parse(created) : NaN;
  return Number.isFinite(ms) ? { ...identity, createdAtMs: ms } : identity;
}

async function probeCursorWebAccount(account, fetchWeb, opts = {}) {
  const get = (url) => requestWebJson(fetchWeb, url, opts);
  const identity = await get(AUTH_ME_URL);
  const first = webIdentity(identity);
  if (!first.ok) return first;
  const changed = { ok: false, error: { kind: 'unauthorized', message: 'Cursor web account changed' } };
  if (first.account.id !== account.id) return changed;
  const result = await probeDashboard(get, (url) => requestWebJson(fetchWeb, url, opts, true), identity);
  if (!result.ok) return result;
  // The browser can sign out or switch accounts while a batch is in flight.
  const last = await readCursorWebIdentity(fetchWeb, opts);
  if (!last.ok) return last;
  return last.account.id === account.id ? result : changed;
}

module.exports = {
  parseUsageSummary,
  parseRequestUsage,
  parseGrokBotUsage,
  parsePlanInfo,
  parsePrepaidBilling,
  parseCurrentPeriodUsage,
  parseUserInfo,
  probe,
  readCursorWebIdentity,
  probeCursorWebAccount,
  requestJson,
  USAGE_SUMMARY_URL,
  AUTH_ME_URL,
  REQUEST_USAGE_URL,
  SAND_USAGE_URL,
  PLAN_INFO_URL,
  PREPAID_BILLING_URL,
  CURRENT_PERIOD_USAGE_URL,
  SAND_TIMEOUT_MS
};
