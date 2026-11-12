import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = {
  'compose.yaml': 'examples/local-release/compose.template.yaml',
  'compose.apparmor.yaml': 'examples/local-release/compose.apparmor.yaml',
  'README.md': 'examples/local-release/README.md',
  'opencode-v1.json': 'examples/local-release/opencode-v1.json',
  'opencode-v2.json': 'examples/local-release/opencode-v2.json',
  'codex.toml': 'examples/local-release/codex.toml',
  'claude-code.json': 'examples/local-release/claude-code.json',
  'AGENTS.md': 'examples/local/AGENTS.md',
  'company-research.md': 'examples/local/company-research.md',
  'docker-browser-seccomp.json': 'scripts/docker-browser-seccomp.json',
  'docker-local-apparmor': 'scripts/docker-local-apparmor',
  'LICENSE': 'LICENSE',
  'docker-seccomp-LICENSE': 'scripts/docker-seccomp-LICENSE',
};
export const bundleFiles = [...Object.keys(sources), 'manifest.json'].sort();

export async function packageLocalRelease(outputDirectory) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'Invalid release version.');
  const output = resolve(outputDirectory);
  const staging = await mkdtemp(join(tmpdir(), 'plompy-local-release-'));
  const name = `plompy-local-${version}.tar.gz`;
  try {
    const manifest = { version, image: `ghcr.io/dalkedev/plompy-engine:${version}-local`, browserImage: `ghcr.io/dalkedev/plompy-engine:${version}-local-browser`, files: {} };
    for (const [destination, source] of Object.entries(sources)) {
      const content = (await readFile(join(root, source), 'utf8')).replaceAll('@VERSION@', version);
      await writeFile(join(staging, destination), content, { mode: 0o644, flag: 'wx' });
      manifest.files[destination] = createHash('sha256').update(content).digest('hex');
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
    // Only explicitly enumerated public files enter the archive, never a checkout
    // directory, environment, runtime volume, dependency tree or credential file.
    await exec('tar', ['-czf', join(staging, name), '-C', staging, ...bundleFiles], { timeout: 30_000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const archive = await readFile(join(staging, name));
    const checksum = createHash('sha256').update(archive).digest('hex');
    await mkdir(output, { recursive: true });
    await copyFile(join(staging, name), join(output, name), constants.COPYFILE_EXCL);
    await writeFile(join(output, `${name}.sha256`), `${checksum}  ${name}\n`, { mode: 0o644, flag: 'wx' });
    return { version, archive: join(output, name), checksum, files: bundleFiles };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/package-local-release.mjs OUTPUT_DIRECTORY');
  process.stdout.write(JSON.stringify(await packageLocalRelease(process.argv[2]), null, 2) + '\n');
}
