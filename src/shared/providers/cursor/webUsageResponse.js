// @ts-check
'use strict';

/** @param {Response} response @param {number} remainingBytes */
async function readUsageJson(response, remainingBytes) {
  if (!response.body) throw new Error('Cursor usage response was empty');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > remainingBytes) {
        await reader.cancel();
        throw new Error('Cursor usage exceeds the supported history size');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return { json: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes }; }
  catch (cause) { throw new Error('Invalid Cursor usage events response', { cause }); }
}

module.exports = { readUsageJson };
