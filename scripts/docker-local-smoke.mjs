// Test only fresh local-image containers. No host account, public traffic or model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const execute = promisify(execFile);
const [image, variant] = process.argv.slice(2);
assert(image && ['local', 'local-browser'].includes(variant), 'Usage: node scripts/docker-local-smoke.mjs IMAGE local|local-browser');
const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = `plompy-local-release-smoke-${randomBytes(8).toString('hex')}`;
const container = `${prefix}-server`;
const volumes = ['config', 'secrets', 'artifacts'].map(name => `${prefix}-${name}`);
const docker = async (...args) => (await execute('docker', args, { timeout: 60_000, maxBuffer: 2_097_152 })).stdout;
const security = ['--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${resolve(root, 'scripts/docker-browser-seccomp.json')}`,
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--shm-size', '256m', '--pids-limit', '256', '--memory', '2g'];
if (process.env.PLOMPY_DOCKER_APPARMOR_PROFILE) security.push('--security-opt', `apparmor=${process.env.PLOMPY_DOCKER_APPARMOR_PROFILE}`);
const mounts = ['config', 'secrets', 'artifacts'].flatMap((name, i) => ['-v', `${volumes[i]}:/var/lib/plompy-local/${name}`]);
const fixtures = ['-v', `${resolve(root, 'scripts/docker-local-smoke-client.mjs')}:/tmp/plompy-release-client.mjs:ro`,
  '-v', `${resolve(root, 'packages/local-mcp/test/browser-smoke.mjs')}:/opt/plompy/packages/local-mcp/test/browser-smoke.mjs:ro`];
const readClient = async phase => JSON.parse(await docker('exec', container, 'node', '/tmp/plompy-release-client.mjs', phase, variant));
try {
  await docker('run', '--rm', ...security, ...mounts, image, 'node', 'scripts/integrations.mjs', 'init', '--mode', 'local');
  // Re-running init must preserve private credentials and configuration.
  await docker('run', '--rm', ...security, ...mounts, image, 'node', 'scripts/integrations.mjs', 'init', '--mode', 'local');
  if (variant === 'local-browser') await docker('run', '--rm', ...security, ...mounts, image, 'node', 'scripts/integrations.mjs', 'add', 'playwright', '--mode', 'local');
  await docker('run', '-d', '--name', container, ...security, ...mounts, ...fixtures, image);
  const waitReady = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:7331/health').then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))");
        return;
      } catch { await setTimeout(100); }
    }
    throw new Error('The isolated local service did not become ready.');
  };
  await waitReady();
  const before = await readClient('write');
  if (variant === 'local-browser') {
    const browser = JSON.parse(await docker('exec', container, 'node', 'packages/local-mcp/test/browser-smoke.mjs'));
    assert.equal(browser.result, 'pass');
    assert.equal(browser.sandbox, 'enabled; no disabling flags');
    assert.equal(browser.uid, 1000);
  }
  await docker('restart', '--time', '30', container);
  await waitReady();
  assert.deepEqual(await readClient('read'), before, 'Private config, token and exact artifact bytes must survive a real restart.');
  console.log(JSON.stringify({ result: 'pass', variant, uid: 1000, network: 'none', authenticatedMcp: true,
    artifactRoundtrip: ['json', 'csv'], restartPersistence: true, browserSandbox: variant === 'local-browser' ? 'verified' : 'not included' }));
} finally {
  await docker('rm', '-f', container).catch(() => {});
  for (const volume of volumes) await docker('volume', 'rm', volume).catch(() => {});
}
