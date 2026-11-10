import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const fixtureRoot = join(publicRoot, "examples/acceptance/fixture");
const fixtureId = "quantity-parser-v1";
const manifestName = "acceptance-manifest.json";
const files = [".gitignore", "AGENTS.md", "SPEC.md", "package.json", "src/quantity.mjs", "test/quantity.test.mjs"];
const mutableFile = "src/quantity.mjs";
const cases = [
  { id: "zero", input: "0", expect: "value", value: 0 },
  { id: "leading-zero", input: "000", expect: "value", value: 0 },
  { id: "negative-zero", input: "-0", expect: "value", value: 0 },
  { id: "positive", input: "19", expect: "value", value: 19 },
  { id: "trimmed", input: " \t0042\n", expect: "value", value: 42 },
  { id: "max-safe", input: "9007199254740991", expect: "value", value: 9007199254740991 },
  { id: "negative-one", input: "-1", expect: "range" },
  { id: "negative-trimmed", input: " -20 ", expect: "range" },
  { id: "negative-leading-zero", input: "-0007", expect: "range" },
  { id: "unsafe-positive", input: "9007199254740992", expect: "range" },
  { id: "unsafe-negative", input: "-9007199254740992", expect: "range" },
  { id: "undefined", undefinedInput: true, expect: "type" },
  { id: "null", input: null, expect: "type" },
  { id: "number-zero", input: 0, expect: "type" },
  { id: "number-negative", input: -1, expect: "type" },
  { id: "boolean", input: false, expect: "type" },
  { id: "object", input: {}, expect: "type" },
  { id: "empty", input: "", expect: "type" },
  { id: "whitespace", input: " \t", expect: "type" },
  { id: "fraction", input: "1.5", expect: "type" },
  { id: "exponent", input: "1e2", expect: "type" },
  { id: "plus-sign", input: "+1", expect: "type" },
  { id: "trailing-junk", input: "2kg", expect: "type" },
  { id: "hex", input: "0x10", expect: "type" },
  { id: "internal-space", input: "1 2", expect: "type" },
];

class AcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new AcceptanceError(code, message); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (parent, child) => {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

function absolutePath(input) {
  if (typeof input !== "string" || !isAbsolute(input) || input !== normalize(input) ||
      /[\x00-\x1f\x7f]/.test(input) || input.split(/[\\/]/).some((part) => part === "." || part === "..") ||
      input === parse(input).root) {
    fail("unsafe_path", "Use a normalized absolute path without traversal or control characters.");
  }
  return input;
}

// Reject aliases rather than silently placing private evidence in another location.
async function noSymlinkPath(input) {
  absolutePath(input);
  const root = parse(input).root;
  let current = root;
  for (const part of relative(root, input).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail("symlink_path", "Symlink paths are refused; use a canonical physical path.");
  }
  if (await realpath(input) !== input) fail("aliased_path", "Use the canonical physical path.");
  return input;
}

async function regularFile(path, limit = 32 * 1024) {
  await noSymlinkPath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) {
    fail("unsafe_file", "A required file is not a bounded, unlinked regular file.");
  }
  const bytes = await readFile(path);
  if (bytes.length > limit || bytes.length !== info.size) fail("changed_file", "A required file changed during inspection.");
  return bytes;
}

async function templates() {
  const result = new Map();
  for (const name of files) result.set(name, await regularFile(join(fixtureRoot, name)));
  return result;
}

// Deliberately omit provider credentials, NODE_OPTIONS, Git overrides, HOME, and proxies.
function childEnvironment() {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR"])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
  };
}

/** Bound ordinary child processes and their process group; this is not a sandbox. */
function runBounded(binary, args, { cwd, timeoutMs = 4000, maxOutputBytes = 16 * 1024 } = {}) {
  return new Promise((done) => {
    let child, timer, killTimer, settled = false, killStarted = false, reason = null, size = 0;
    const stdout = [], stderr = [];
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform === "win32") {
        if (killStarted) return;
        killStarted = true;
        const killer = execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 1000, maxBuffer: 1024 }, () => child.kill("SIGKILL"));
        killer.unref();
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already exited. */ }
      }
    };
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      kill();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      done({ reason, exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const terminate = (why) => {
      if (reason) return;
      reason = why;
      kill();
      // Even an inherited pipe must not leave the operator waiting forever.
      killTimer = setTimeout(() => { child?.kill("SIGKILL"); finish(null); }, process.platform === "win32" ? 1500 : 300);
    };
    try {
      child = spawn(binary, args, {
        cwd, env: childEnvironment(), detached: process.platform !== "win32",
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxOutputBytes) terminate("output_limit");
          else chunks.push(chunk);
        });
      }
      child.once("error", () => { reason = "start_failed"; finish(null); });
      child.once("close", (code) => finish(code));
      timer = setTimeout(() => terminate("timeout"), timeoutMs);
    } catch { reason = "start_failed"; finish(null); }
  });
}

async function git(repository, args, { raw = false } = {}) {
  const result = await runBounded("git", [
    "-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
    "-c", "user.name=Acceptance Fixture", "-c", "user.email=acceptance@example.invalid", ...args,
  ], { cwd: repository, maxOutputBytes: 64 * 1024 });
  if (result.reason || result.exitCode !== 0 || result.stderr && !["init", "commit"].includes(args[0]))
    fail("git_check", "Git fixture initialization or baseline verification failed; child output was withheld.");
  return raw ? result.stdout : result.stdout.trimEnd();
}

const checker = `
const cases = ${JSON.stringify(cases)};
const failed = [];
let checked = 0;
try {
  const { parseQuantity } = await import(process.argv[1]);
  if (typeof parseQuantity !== "function") throw new Error("missing_export");
  for (const entry of cases) {
    checked++;
    try {
      const value = parseQuantity(entry.undefinedInput ? undefined : entry.input);
      if (entry.expect !== "value" || !Object.is(value, entry.value)) failed.push(entry.id);
    } catch (error) {
      if (!(entry.expect === "type" && error instanceof TypeError) &&
          !(entry.expect === "range" && error instanceof RangeError)) failed.push(entry.id);
    }
  }
} catch { failed.push("module_export"); }
process.stdout.write(JSON.stringify({ nonce: process.argv[2], checked, failed }));
`;

function outcome(status, check, extra = {}) {
  return { schemaVersion: 1, fixture: fixtureId, status, check, ...extra };
}

/** Independent operator check. Never invokes a candidate-controlled npm test script. */
export async function verifyAcceptance(manifestPath, { timeoutMs = 4000 } = {}) {
  try {
    absolutePath(manifestPath);
    if (within(publicRoot, manifestPath) || !manifestPath.endsWith(`${sep}${manifestName}`))
      fail("manifest_location", "Keep the operator manifest outside the public checkout at its original name.");
    const trusted = await templates();
    let manifest;
    try { manifest = JSON.parse((await regularFile(manifestPath, 16 * 1024)).toString("utf8")); }
    catch (error) {
      if (error instanceof AcceptanceError) throw error;
      fail("manifest_format", "The operator manifest is missing or is not valid bounded JSON.");
    }
    const repository = join(dirname(manifestPath), "repository");
    const expectedHashes = Object.fromEntries([...trusted].map(([name, bytes]) => [name, hash(bytes)]));
    if (!manifest || Object.keys(manifest).sort().join(",") !== "baselineCommit,files,fixture,repository,schemaVersion" ||
        manifest.schemaVersion !== 1 || manifest.fixture !== fixtureId || manifest.repository !== repository ||
        !/^[0-9a-f]{40,64}$/.test(manifest.baselineCommit) ||
        JSON.stringify(manifest.files) !== JSON.stringify(expectedHashes)) {
      fail("manifest_integrity", "The operator manifest does not match this trusted acceptance kit.");
    }
    await noSymlinkPath(repository);
    await noSymlinkPath(join(repository, ".git"));
    if (!(await lstat(join(repository, ".git"))).isDirectory() ||
        resolve(await git(repository, ["rev-parse", "--show-toplevel"])) !== repository)
      fail("repository_root", "The fixture must remain its own Git root.");
    for (const [name, original] of trusted) {
      const current = await regularFile(join(repository, name));
      if (name !== mutableFile && !current.equals(original))
        fail("fixture_integrity", "An existing test, specification, instruction, or package file changed or disappeared.");
      const baseline = await git(repository, ["show", `${manifest.baselineCommit}:${name}`], { raw: true });
      if (baseline !== original.toString("utf8"))
        fail("baseline_integrity", "The original Git baseline no longer matches the trusted fixture.");
    }
    const nonce = randomUUID();
    const result = await runBounded(process.execPath,
      ["--input-type=module", "--eval", checker, pathToFileURL(join(repository, mutableFile)).href, nonce],
      { cwd: repository, timeoutMs: Math.max(100, Math.min(timeoutMs, 10_000)) });
    if (result.reason) return outcome("FAIL", `candidate_${result.reason}`);
    if (result.exitCode !== 0 || result.stderr) return outcome("FAIL", "candidate_process");
    let observed;
    try { observed = JSON.parse(result.stdout); } catch { return outcome("FAIL", "candidate_output"); }
    const ids = new Set([...cases.map((entry) => entry.id), "module_export"]);
    if (!observed || Object.keys(observed).sort().join(",") !== "checked,failed,nonce" ||
        observed.nonce !== nonce || observed.checked !== cases.length || !Array.isArray(observed.failed) ||
        observed.failed.some((id) => !ids.has(id)) || new Set(observed.failed).size !== observed.failed.length)
      return outcome("FAIL", "candidate_output");
    return outcome(observed.failed.length ? "FAIL" : "PASS", "fixture_behavior", {
      passed: cases.length - observed.failed.length, total: cases.length, failed: observed.failed,
    });
  } catch (error) {
    return outcome("FAIL", error instanceof AcceptanceError ? error.code : "fixture_unavailable");
  }
}

export async function initAcceptance(destination) {
  absolutePath(destination);
  await noSymlinkPath(dirname(destination));
  if (within(publicRoot, destination)) fail("public_destination", "Keep the acceptance task and evidence outside the public source checkout.");
  const originals = await templates();
  // Exclusive creation: do not replace an existing directory, file, or symlink.
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("destination_exists", "Destination already exists; existing files were preserved.");
    fail("destination_create", "Cannot create a new private destination; its physical parent directory must already exist.");
  }
  const repository = join(destination, "repository");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(join(repository, "src"), { mode: 0o700 });
  await mkdir(join(repository, "test"), { mode: 0o700 });
  await mkdir(join(destination, "empty-git-template"), { mode: 0o700 });
  for (const [name, bytes] of originals)
    await writeFile(join(repository, name), bytes, { mode: 0o600, flag: "wx" });
  await git(repository, ["init", "--quiet", "--initial-branch=main", `--template=${join(destination, "empty-git-template")}`]);
  await git(repository, ["add", "--", ...files]);
  await git(repository, ["commit", "--quiet", "-m", "Initialize synthetic quantity acceptance fixture"]);
  const baselineCommit = await git(repository, ["rev-parse", "HEAD"]);
  const manifest = join(destination, manifestName);
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1, fixture: fixtureId, repository, baselineCommit,
    files: Object.fromEntries([...originals].map(([name, bytes]) => [name, hash(bytes)])),
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const baseline = await verifyAcceptance(manifest);
  if (baseline.check !== "fixture_behavior" || baseline.status !== "FAIL" ||
      baseline.failed?.join(",") !== "negative-one,negative-trimmed,negative-leading-zero")
    fail("baseline_not_red", "The expected independent RED baseline was not observed; inspect this partial fixture before using it.");
  const goal = `!goal 30m --repo ${JSON.stringify(repository)} Fix src/quantity.mjs to satisfy SPEC.md. Reject negative quantities while allowing zero. Keep existing tests, specification, package script and repository instructions unchanged; run the tests and report observed evidence. No publishing or deployment.`;
  return { repository, manifest, goal, baseline };
}

async function main(args) {
  if (args.length !== 3 || !["init", "verify"].includes(args[0]) ||
      args[1] !== (args[0] === "init" ? "--destination" : "--manifest"))
    fail("usage", "Usage: acceptance init --destination <new absolute private directory> | acceptance verify --manifest <absolute acceptance-manifest.json>");
  if (args[0] === "init") {
    const result = await initAcceptance(args[2]);
    // Discord expects JSON quoting; a shell command needs its own escaping.
    const container = process.env.SZPONT_CONTAINER_RUNNER === "codex";
    const powershell = process.platform === "win32" && !container;
    const manifestArgument = powershell
      ? `'${result.manifest.replaceAll("'", "''")}'` // PowerShell
      : `'${result.manifest.replaceAll("'", `'"'"'`)}'`; // POSIX shell
    const verification = container
      ? `docker compose run --rm engine acceptance verify --manifest ${manifestArgument}`
      : `npm run acceptance -- verify --manifest ${manifestArgument}`;
    const where = container
      ? "on the Docker host in a POSIX shell, using the same Compose project, environment and volumes"
      : `from this trusted checkout (${powershell ? "PowerShell" : "POSIX shell"})`;
    console.log(`Synthetic fixture initialized in its own Git repository.\nRepository: ${JSON.stringify(result.repository)}\nOperator manifest (outside the bound repository): ${JSON.stringify(result.manifest)}\nIndependent baseline: RED as expected (${result.baseline.failed.length} negative regressions). No model or Discord task was run.\nUse a destination inside your configured private artifacts/workspace. Copy into your private Discord thread:\n\n${result.goal}\n\nAfter the agent finishes, run ${where}:\n${verification}`);
  } else {
    const result = await verifyAcceptance(args[2]);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof AcceptanceError ? `${error.code}: ${error.message}` :
      "acceptance_failed: Initialization failed; any newly created partial fixture was preserved for inspection.");
    process.exitCode = 1;
  });
}
