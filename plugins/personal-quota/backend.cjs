'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

function usageSample(value, observedAt) {
  const { usedPercent, resetText, plan } = value || {};
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
      || typeof resetText !== 'string' || !resetText.trim()
      || typeof plan !== 'string' || !plan.trim()
      || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) return null;
  return { usedPercent, resetText: resetText.trim(), observedAt, plan: plan.trim() };
}

exports.activate = ({ dataDirectory }) => {
  const file = path.join(dataDirectory, 'cursor-usage.json');
  const abort = new AbortController();
  let pending;

  function cached() {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const sample = usageSample(record, record?.observedAt);
      return sample && { ...sample, live: false };
    } catch { return null; }
  }

  async function sync() {
    if (process.platform !== 'win32') return cached();
    try {
      const shellDir = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
      const { stdout } = await run(path.join(shellDir, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        path.join(__dirname, 'read-cursor-usage.ps1')], {
        // Get-AuthenticodeSignature must resolve from Windows PowerShell, including when launched by PowerShell 7.
        env: { ...process.env, PSModulePath: path.join(shellDir, 'Modules') },
        windowsHide: true, timeout: 12000, maxBuffer: 16384, encoding: 'utf8', signal: abort.signal
      });
      const result = JSON.parse(stdout.trim());
      const sample = result?.ok === true && usageSample(result, new Date().toISOString());
      if (!sample) return cached();
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(sample), { mode: 0o600 });
      fs.renameSync(temporary, file);
      return { ...sample, live: true };
    } catch { return cached(); }
  }

  return {
    call(method) {
      if (method === 'getCursorUsage') return cached();
      if (method !== 'syncCursorUsage') throw Error('Unknown quota operation');
      pending ??= sync().finally(() => { pending = null; });
      return pending;
    },
    dispose() { abort.abort(); }
  };
};
