import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// Check Git's index so a force-added ignored file cannot bypass this guard.
// This catches known runtime paths; it does not replace a review for secrets.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const privateRoots = new Set(['agent', 'workspace', 'state', 'artifacts', 'browser-profile']);
const privateNames = new Set(['auth.json', '.szpont-identity.json', 'cookies.sqlite']);

const rejected = tracked.filter((path) => {
  const parts = path.split('/');
  const name = basename(path);
  return (
    privateRoots.has(parts[0]) ||
    parts.includes('.codex') ||
    privateNames.has(name) ||
    (name !== '.env.example' && /^\.env(?:\..+)?$/.test(name))
  );
});

if (rejected.length > 0) {
  console.error('Private runtime files must stay outside the public repository:');
  for (const path of rejected) console.error(`  ${JSON.stringify(path)}`);
  console.error('Use synthetic examples under examples/workspace/ and .env.example instead.');
  process.exitCode = 1;
} else {
  console.log(`Public tree check passed (${tracked.length} tracked paths).`);
}
