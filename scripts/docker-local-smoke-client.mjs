// Mounted only by docker-local-smoke.mjs; not included in production images.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire('/opt/plompy/packages/local-mcp/package.json');
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const [phase, variant] = process.argv.slice(2);
assert(['write', 'read'].includes(phase));
assert.equal(process.getuid(), 1000);
assert.equal(process.version, 'v26.13.0');
for (const key of ['DISCORD_BOT_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN']) assert.equal(process.env[key], undefined);
await assert.rejects(writeFile('/opt/plompy/smoke-must-not-write', 'fixture'));
const root = '/var/lib/plompy-local';
const token = (await readFile(`${root}/secrets/access-token`, 'utf8')).trim();
const headers = { Authorization: `Bearer ${token}` };
assert.equal((await fetch('http://127.0.0.1:7331/health')).status, 401);
assert.equal((await fetch('http://127.0.0.1:7331/health', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
assert.equal((await fetch('http://127.0.0.1:7331/health', { headers })).status, 200);
const client = new Client({ name: 'plompy-local-release-fixture', version: '1.0.0' });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  assert.notEqual(result.isError, true, `MCP ${name} must succeed`);
  return JSON.parse(result.content.find(item => item.type === 'text').text);
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7331/mcp'), { requestInit: { headers } }), { timeout: 10_000 });
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['artifacts_export', 'artifacts_list', 'artifacts_read', ...(variant === 'local-browser' ? ['browser_read'] : []), 'plompy_status', 'web_fetch'].sort());
  assert.equal((await call('plompy_status')).profile, 'research');
  const records = [{ company_name: '=Synthetic Studio', public_email: 'hello@fixture.example', source_url: 'https://fixture.example/contact', draft_body: 'University project fixture only. No email sent.' }];
  if (phase === 'write') for (const format of ['json', 'csv']) {
    const args = { name: `release-fixture.${format}`, format, records, idempotencyKey: `release-fixture-${format}` };
    await call('artifacts_export', args);
    assert.equal((await call('artifacts_export', args)).reused, true);
  }
  const json = (await call('artifacts_read', { name: 'release-fixture.json' })).content;
  const csv = (await call('artifacts_read', { name: 'release-fixture.csv' })).content;
  assert.deepEqual(JSON.parse(json), records);
  assert(csv.includes("\"'=Synthetic Studio\""), 'CSV formula prefix must be escaped');
  const snapshot = {};
  for (const path of ['config/config.json', 'secrets/access-token', 'artifacts/release-fixture.json', 'artifacts/release-fixture.csv'])
    snapshot[path] = createHash('sha256').update(await readFile(`${root}/${path}`)).digest('hex');
  assert.equal(json, await readFile(`${root}/artifacts/release-fixture.json`, 'utf8'));
  assert.equal(csv, await readFile(`${root}/artifacts/release-fixture.csv`, 'utf8'));
  // Parent captures these synthetic digests in memory, compares and never prints them.
  console.log(JSON.stringify(snapshot));
} finally { await client.close(); }
