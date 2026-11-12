import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const repository = 'dalkedev/plompy-engine';
const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Publication metadata only. Changes remain authored once in CHANGELOG.md.
export function releaseCatalog(releases, latestTag, checkedAt) {
  const published = releases.filter(release => !release.draft && release.published_at);
  const tags = new Set();
  const entries = published.map(release => {
    assert(tagPattern.test(release.tag_name), 'Unsupported release tag.');
    assert(!tags.has(release.tag_name), 'Duplicate release tag.');
    tags.add(release.tag_name);
    const url = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
    assert.equal(release.html_url, url, 'Unexpected release URL.');
    assert(Number.isFinite(Date.parse(release.published_at)), 'Invalid publication date.');
    const rawTitle = (release.name || '').replace(/^(?:Plompy|Szpont)(?: Engine)?\s+v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*(?:[\u2014\u2013:-]\s*)?/i, '').trim();
    return {
      tag: release.tag_name,
      title: (rawTitle || `Release ${release.tag_name.slice(1)}`).replaceAll('\u2014', ':'),
      publishedAt: release.published_at,
      prerelease: Boolean(release.prerelease),
      url,
      assets: release.assets.map(asset => {
        const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
        assert(asset.browser_download_url.startsWith(expected), 'Unexpected asset URL.');
        assert(Number.isSafeInteger(asset.size) && asset.size >= 0, 'Invalid asset size.');
        return { name: asset.name, url: asset.browser_download_url, size: asset.size };
      }),
    };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  assert(entries.some(entry => entry.tag === latestTag && !entry.prerelease), 'Latest stable release is not published.');
  return { schema: 1, repository, checkedAt, latestStableTag: latestTag, releases: entries };
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'plompy-release-docs' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub publication lookup failed: HTTP ${response.status}`);
  return response.json();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await github(`releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
    if (page === 20) throw new Error('Release pagination limit reached; catalog not written.');
  }
  const latest = await github('releases/latest');
  const catalog = releaseCatalog(releases, latest.tag_name, new Date().toISOString());
  await writeFile(fileURLToPath(new URL('./catalog.json', import.meta.url)), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Recorded ${catalog.releases.length} published releases; latest stable ${catalog.latestStableTag}.`);
}
