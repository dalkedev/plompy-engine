import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCatalog } from './sync.mjs';

const release = (tag, extra = {}) => ({ tag_name: tag, name: `Plompy ${tag}`, html_url: `https://github.com/dalkedev/plompy-engine/releases/tag/${tag}`, published_at: '2026-11-12T12:00:00Z', prerelease: false, draft: false, assets: [], ...extra });

test('catalog includes published versions only and retains explicit stable status', () => {
  const catalog = releaseCatalog([release('v0.13.0'), release('v0.14.0-rc.1', { prerelease: true }), release('v0.15.0', { draft: true }), release('v0.16.0', { published_at: null })], 'v0.13.0', '2026-11-12T13:00:00Z');
  assert.equal(catalog.releases.length, 2);
  assert.equal(catalog.latestStableTag, 'v0.13.0');
  assert.equal(catalog.releases[1].prerelease, true);
});

test('rejects inconsistent latest release, duplicate tags and unexpected download origins', () => {
  assert.throws(() => releaseCatalog([release('v0.13.0')], 'v0.14.0', ''), /not published/);
  assert.throws(() => releaseCatalog([release('v0.13.0'), release('v0.13.0')], 'v0.13.0', ''), /Duplicate/);
  assert.throws(() => releaseCatalog([release('v0.13.0', { assets: [{ name: 'kit.zip', size: 1, browser_download_url: 'https://example.com/kit.zip' }] })], 'v0.13.0', ''), /asset URL/);
});
