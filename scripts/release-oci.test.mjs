import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { inspectLayout, verifyCombinedIndex } from './release-oci.mjs';

function fixture(t, architecture = 'amd64', { sbom = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'plompy-release-oci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'blobs', 'sha256'), { recursive: true });
  const put = (value, extra = {}) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'blobs', 'sha256', hash), bytes);
    return { digest: `sha256:${hash}`, size: bytes.length, ...extra };
  };
  const revision = 'b'.repeat(40);
  const config = put({ os: 'linux', architecture, config: { Labels: { 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.version': '0.2.0' } } });
  const layer = put(Buffer.from('synthetic runtime bytes'));
  const runtime = put({ config, layers: [layer] }, { platform: { os: 'linux', architecture } });
  const predicates = ['https://slsa.dev/provenance/v1'];
  if (sbom) predicates.push('https://spdx.dev/Document');
  const attestations = predicates.map((predicateType) => put({ predicateType, subject: [{ digest: { sha256: runtime.digest.slice(7) } }] }));
  const attestation = put({ config: put({}), layers: attestations, subject: runtime }, {
    platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': runtime.digest },
  });
  const index = put({ manifests: [runtime, attestation] });
  writeFileSync(join(directory, 'index.json'), JSON.stringify({ manifests: [index] }));
  return { directory, revision, config, layer, runtime, attestation };
}

test('OCI inspection binds one runtime and its attestations to verified blob bytes', (t) => {
  const source = fixture(t);
  const report = inspectLayout(source.directory, 'amd64', { revision: source.revision, version: '0.2.0' });
  assert.equal(report.configDigest, source.config.digest);
  assert.equal(report.manifestDigest, source.runtime.digest);
  assert.deepEqual(report.attestationDigests, [source.attestation.digest]);
});

test('another revision or changed runtime layer blocks artifact promotion', (t) => {
  const source = fixture(t);
  assert.throws(() => inspectLayout(source.directory, 'amd64', { revision: 'c'.repeat(40) }), /revision differs/);
  const path = join(source.directory, 'blobs', 'sha256', source.layer.digest.slice(7));
  writeFileSync(path, Buffer.from('tampered runtime bytes!'));
  assert.throws(() => inspectLayout(source.directory, 'amd64'), /OCI blob (size|digest) mismatch/);
});

test('a release archive without the promised SBOM is rejected', (t) => {
  const source = fixture(t, 'arm64', { sbom: false });
  assert.throws(() => inspectLayout(source.directory, 'arm64'), /missing its SBOM/);
});

test('the combined index must preserve both tested runtime and attestation sets', (t) => {
  const amd64 = fixture(t);
  const arm64 = fixture(t, 'arm64');
  const reports = [inspectLayout(amd64.directory, 'amd64'), inspectLayout(arm64.directory, 'arm64')];
  const manifests = [amd64.runtime, amd64.attestation, arm64.runtime, arm64.attestation];
  verifyCombinedIndex({ manifests }, reports);
  assert.throws(() => verifyCombinedIndex({ manifests: manifests.slice(0, 3) }, reports), /differs from the tested/);
  assert.throws(() => verifyCombinedIndex({ manifests: manifests.map((entry, i) => i === 0 ? { ...entry, digest: `sha256:${'f'.repeat(64)}` } : entry) }, reports), /differs from the tested/);
});
