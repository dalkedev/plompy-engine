// Runs only against a dedicated initialized smoke container with synthetic data.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
const container = process.argv[2] ?? "plompy-local-smoke-local-1";
assert.match(container, /^plompy-local-smoke[a-z0-9-]*-local-1$/);
const source = `
  import { readFile, readdir } from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  const base='/var/lib/plompy-local';
  const digest=async(path)=>createHash('sha256').update(await readFile(path)).digest('hex');
  const names=(await readdir(base+'/artifacts')).filter(name=>name.startsWith('opencode-acceptance-')&&name.endsWith('.json')).sort();
  if(!names.length) throw new Error('First run the actual OpenCode acceptance to create a synthetic artifact.');
  const result={config:await digest(base+'/config/config.json'),access:await digest(base+'/secrets/access-token'),artifacts:{}};
  for(const name of names)result.artifacts[name]=await digest(base+'/artifacts/'+name);
  console.log(JSON.stringify(result));
`;
const snapshot = async () => JSON.parse((await exec("docker", ["exec", container, "node", "--input-type=module", "-e", source], { timeout: 5000 })).stdout);
const before = await snapshot();
await exec("docker", ["restart", "--time", "30", container], { timeout: 40_000 });
const token = (await exec("docker", ["exec", container, "cat", "/var/lib/plompy-local/secrets/access-token"], { timeout: 5000 })).stdout.trim();
let ready = false;
for (let attempt = 0; attempt < 20 && !ready; attempt++) {
  try { ready = (await fetch("http://127.0.0.1:7331/health", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })).ok; }
  catch { /* bounded startup wait */ }
  if (!ready) await setTimeout(100);
}
assert.equal(ready, true, "The actual service must become available after restart.");
assert.deepEqual(await snapshot(), before, "Config, access token and exact artifact bytes must survive the restart.");
console.log(JSON.stringify({ result: "pass", test: "real-container-restart", persisted: ["configuration", "access token", "exact artifact bytes"], artifactCount: Object.keys(before.artifacts).length }));
