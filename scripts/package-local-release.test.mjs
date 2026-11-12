import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFiles, packageLocalRelease } from './package-local-release.mjs';

const exec = promisify(execFile);
test('standalone download contains only allowlisted public files, pinned images and usable client references', async () => {
  const output = await mkdtemp(join(tmpdir(), 'plompy-kit-test-'));
  try {
    const result = await packageLocalRelease(output);
    const bytes = await readFile(result.archive);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.checksum);
    const listing = (await exec('tar', ['-tzf', result.archive])).stdout.trim().split('\n').sort();
    assert.deepEqual(listing, bundleFiles);
    const file = async name => (await exec('tar', ['-xOzf', result.archive, name])).stdout;
    const manifest = JSON.parse(await file('manifest.json'));
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await file(name)).digest('hex'), hash);
    const compose = await file('compose.yaml');
    assert.match(compose, /^name: plompy-local/m);
    assert.ok(compose.includes(`ghcr.io/dalkedev/plompy-engine:${result.version}-local-browser`));
    assert.ok(compose.includes('127.0.0.1:7331:7331'));
    assert.ok(!/\bbuild:|@VERSION@|docker\.sock|privileged:\s*true/.test(compose));
    assert.ok(listing.includes('docker-browser-seccomp.json') && listing.includes('docker-local-apparmor'));
    const v1 = JSON.parse(await file('opencode-v1.json'));
    assert.equal(v1.mcp.plompy.headers.Authorization, 'Bearer {env:PLOMPY_LOCAL_TOKEN}');
    const v2 = JSON.parse(await file('opencode-v2.json'));
    assert.equal(v2.mcp.servers.plompy.url, 'http://127.0.0.1:7331/mcp');
    assert.equal(JSON.parse(await file('claude-code.json')).mcpServers.plompy.headers.Authorization, 'Bearer ${PLOMPY_LOCAL_TOKEN}');
    await assert.rejects(packageLocalRelease(output), /EEXIST/);
    assert.equal(createHash('sha256').update(await readFile(result.archive)).digest('hex'), result.checksum);
  } finally { await rm(output, { recursive: true, force: true }); }
});
