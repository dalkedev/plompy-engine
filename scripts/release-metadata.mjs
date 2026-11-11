import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function browserVersions({ project, lock }) {
  const projectVersion = project.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const packages = lock.split(/^\[\[package\]\]\s*$/m).slice(1);
  const browserPackages = packages.filter((entry) => /^name\s*=\s*"plompy-browser"\s*$/m.test(entry));
  assert.equal(browserPackages.length, 1, 'uv.lock must contain exactly one plompy-browser project.');
  const lockVersion = browserPackages[0].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert(projectVersion && lockVersion, 'Both browser project and uv.lock need a version.');
  return [projectVersion, lockVersion];
}

/** Reject malformed tags before they reach a registry, output file, or shell. */
export function releaseMetadata({ tag, repository, revision, versions }) {
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const match = new RegExp(`^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?$`).exec(tag);
  assert(match, 'Release tag must be vMAJOR.MINOR.PATCH, optionally with a SemVer prerelease.');
  assert(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository), 'Invalid repository name.');
  assert(/^[a-f0-9]{40}$/.test(revision), 'Release revision must be a full Git commit SHA.');
  const version = tag.slice(1);
  assert(version.length <= 128, 'Release version exceeds the registry tag length.');
  assert(versions.length > 0 && versions.every((value) => value === version), 'Tag, packages, lockfile, and browser versions must agree.');
  const image = `ghcr.io/${repository.toLowerCase()}`;
  const tags = [`${image}:${version}`, `${image}:sha-${revision.slice(0, 12)}`];
  if (!match[4]) tags.push(`${image}:${match[1]}.${match[2]}`, `${image}:latest`);
  return { version, image, tags: tags.join(','), prerelease: Boolean(match[4]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const lock = json('apps/discord-agent/package-lock.json');
  const browser = browserVersions({
    project: readFileSync(resolve(root, 'packages/browser/pyproject.toml'), 'utf8'),
    lock: readFileSync(resolve(root, 'packages/browser/uv.lock'), 'utf8'),
  });
  const result = releaseMetadata({
    tag: process.env.RELEASE_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    revision: process.env.GITHUB_SHA,
    versions: [json('package.json').version, json('apps/discord-agent/package.json').version, lock.version, lock.packages[''].version, ...browser],
  });
  const output = Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
