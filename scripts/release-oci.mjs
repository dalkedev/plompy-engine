import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const parse = (bytes) => JSON.parse(bytes.toString('utf8'));

/** Bind the runnable image, its labels, and its attestations to one OCI export. */
export function inspectLayout(directory, architecture, expected = {}) {
  assert(['amd64', 'arm64'].includes(architecture), 'Unsupported release architecture.');
  const read = (descriptor) => {
    assert(/^sha256:[a-f0-9]{64}$/.test(descriptor.digest), 'Invalid OCI blob digest.');
    const bytes = descriptor.data === undefined
      ? readFileSync(resolve(directory, 'blobs', 'sha256', descriptor.digest.slice(7)))
      : Buffer.from(descriptor.data, 'base64');
    assert.equal(bytes.length, descriptor.size, 'OCI blob size mismatch.');
    assert.equal(sha256(bytes), descriptor.digest, 'OCI blob digest mismatch.');
    return bytes;
  };
  const layout = parse(readFileSync(resolve(directory, 'index.json')));
  assert.equal(layout.manifests?.length, 1, 'Export must contain one named image index.');
  const indexDescriptor = layout.manifests[0];
  const index = parse(read(indexDescriptor));
  const runtimeDescriptors = index.manifests.filter((entry) => entry.platform?.os === 'linux' && entry.platform.architecture === architecture);
  assert.equal(runtimeDescriptors.length, 1, 'Export must contain exactly one runtime for this architecture.');
  const runtimeDescriptor = runtimeDescriptors[0];
  const runtime = parse(read(runtimeDescriptor));
  const config = parse(read(runtime.config));
  assert.equal(config.os, 'linux');
  assert.equal(config.architecture, architecture);
  if (expected.revision) assert.equal(config.config?.Labels?.['org.opencontainers.image.revision'], expected.revision, 'Image revision differs from the release.');
  if (expected.version) assert.equal(config.config?.Labels?.['org.opencontainers.image.version'], expected.version, 'Image version differs from the release.');
  for (const layer of runtime.layers) read(layer);
  const attestations = index.manifests.filter((entry) => entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest');
  assert.equal(index.manifests.length, runtimeDescriptors.length + attestations.length, 'Unexpected platform in the single-architecture export.');
  const predicates = new Set();
  for (const descriptor of attestations) {
    assert.equal(descriptor.annotations['vnd.docker.reference.digest'], runtimeDescriptor.digest, 'Attestation refers to another runtime.');
    const manifest = parse(read(descriptor));
    read(manifest.config);
    if (manifest.subject) assert.equal(manifest.subject.digest, runtimeDescriptor.digest);
    for (const layer of manifest.layers) {
      const statement = parse(read(layer));
      assert(statement.subject?.some((subject) => subject.digest?.sha256 === runtimeDescriptor.digest.slice(7)), 'Attestation subject differs from the tested runtime.');
      predicates.add(statement.predicateType);
    }
  }
  assert(predicates.has('https://spdx.dev/Document'), 'OCI export is missing its SBOM.');
  assert([...predicates].some((value) => /^https:\/\/slsa\.dev\/provenance\//.test(value)), 'OCI export is missing its provenance.');
  return {
    architecture,
    indexDigest: indexDescriptor.digest,
    manifestDigest: runtimeDescriptor.digest,
    configDigest: runtime.config.digest,
    attestationDigests: attestations.map((entry) => entry.digest).sort(),
  };
}

/** The final multiarch index may only combine the already tested manifests. */
export function verifyCombinedIndex(index, reports) {
  const expected = reports.flatMap((report) => [report.manifestDigest, ...report.attestationDigests]).sort();
  const actual = index.manifests.map((entry) => entry.digest).sort();
  assert.deepEqual(actual, expected, 'Published index differs from the tested runtime/attestation set.');
  const platforms = index.manifests.filter((entry) => entry.platform?.os === 'linux').map((entry) => entry.platform.architecture).sort();
  assert.deepEqual(platforms, ['amd64', 'arm64'], 'Published index must contain both native architectures.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'inspect') {
    const [directory, architecture, revision, version] = args;
    process.stdout.write(`${JSON.stringify(inspectLayout(directory, architecture, { revision, version }), null, 2)}\n`);
  } else if (command === 'verify-index') {
    const [index, ...reports] = args;
    assert.equal(reports.length, 2, 'Need both tested architecture reports.');
    verifyCombinedIndex(parse(readFileSync(index)), reports.map((path) => parse(readFileSync(path))));
    process.stdout.write('PASS: published index contains exactly the tested runtimes and attestations.\n');
  } else {
    throw new Error('Usage: release-oci.mjs inspect LAYOUT ARCH REVISION VERSION | verify-index INDEX AMD64_REPORT ARM64_REPORT');
  }
}
