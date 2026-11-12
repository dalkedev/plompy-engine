import assert from 'node:assert/strict';
import test from 'node:test';
import { browserVersions, releaseMetadata, variantTags } from './release-metadata.mjs';

const metadata = (overrides = {}) => releaseMetadata({ tag: 'v0.2.0', repository: 'Owner/Engine', revision: 'a'.repeat(40), versions: ['0.2.0', '0.2.0'], ...overrides });

test('stable releases have exact, revision, minor, and latest tags', () => {
  assert.deepEqual(metadata(), {
    version: '0.2.0', image: 'ghcr.io/owner/engine', prerelease: false,
    tags: 'ghcr.io/owner/engine:0.2.0,ghcr.io/owner/engine:sha-aaaaaaaaaaaa,ghcr.io/owner/engine:0.2,ghcr.io/owner/engine:latest',
  });
});

test('prereleases cannot move stable aliases', () => {
  const result = metadata({ tag: 'v0.3.0-rc.1', versions: ['0.3.0-rc.1'] });
  assert.equal(result.prerelease, true);
  assert.equal(result.tags, 'ghcr.io/owner/engine:0.3.0-rc.1,ghcr.io/owner/engine:sha-aaaaaaaaaaaa');
});

test('a version disagreement blocks publishing', () => {
  assert.throws(() => metadata({ versions: ['0.2.0', '0.1.0'] }), /must agree/);
  assert.throws(() => metadata({ versions: [] }), /must agree/);
});

test('invalid versions and workflow output injection are rejected', () => {
  for (const tag of ['v01.2.0', 'v1.02.0', 'v1.2.03', 'v1.2', 'v1.2.0-01', 'v1.2.0-', 'v1.2.0+build', 'v1.2.0\ntags=bad']) {
    assert.throws(() => metadata({ tag }), /Release tag/);
  }
  assert.throws(() => metadata({ repository: 'owner/repo\nimage=bad' }), /repository/);
  assert.throws(() => metadata({ revision: 'main' }), /commit SHA/);
});

test('the browser lock version participates in release consistency checks', () => {
  const project = '[project]\nname = "plompy-browser"\nversion = "0.2.0"\n';
  const lock = 'version = 1\n\n[[package]]\nname = "dependency"\nversion = "5.0.0"\n\n[[package]]\nname = "plompy-browser"\nversion = "0.2.0"\n';
  assert.deepEqual(browserVersions({ project, lock }), ['0.2.0', '0.2.0']);
  assert.throws(() => metadata({ versions: browserVersions({ project, lock: lock.replace('version = "0.2.0"', 'version = "0.1.0"') }) }), /must agree/);
  assert.throws(() => browserVersions({ project, lock: '' }), /exactly one/);
});


test('local variants retain exact and architecture-independent revision tags without moving engine aliases', () => {
  const result = metadata();
  assert.equal(variantTags(result, 'local'), 'ghcr.io/owner/engine:0.2.0-local,ghcr.io/owner/engine:sha-aaaaaaaaaaaa-local,ghcr.io/owner/engine:0.2-local,ghcr.io/owner/engine:latest-local');
  assert.equal(variantTags(result, 'local-browser'), 'ghcr.io/owner/engine:0.2.0-local-browser,ghcr.io/owner/engine:sha-aaaaaaaaaaaa-local-browser,ghcr.io/owner/engine:0.2-local-browser,ghcr.io/owner/engine:latest-local-browser');
  assert.throws(() => variantTags(result, 'engine'), /Unsupported/);
  assert.throws(() => variantTags({tags: 'ghcr.io/owner/engine:' + 'x'.repeat(128)}, 'local'), /length/);
  const preview = metadata({tag:'v0.3.0-rc.1', versions:['0.3.0-rc.1']});
  assert.equal(variantTags(preview, 'local').includes('latest'), false);
});
