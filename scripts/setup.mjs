import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  chmod,
  open,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";

const execute = promisify(execFile);
const sourceRoot = await realpath(
  fileURLToPath(new URL("../", import.meta.url)),
);
const directories = [
  "workspace",
  "state",
  "artifacts",
  "browser",
  "codex",
  "claude",
  "opencode",
  "github",
];
const messages = {
  arguments:
    "Use --help for supported flags. Tokens are accepted only through hidden terminal input or --token-file, never a token argument.",
  confirmation:
    "Noninteractive setup requires every identity, --yes and one of --token-file or piped --token-stdin. No files were created.",
  platform:
    "Setup requires POSIX file permissions. Prepare this installation on Linux; Windows setup is unsupported.",
  node: "Use Node 24 for setup and the engine.",
  build: "Build the engine before setup: npm run build.",
  path: "Use absolute private paths outside the public checkout; symlinks, unsafe ancestors and overlapping managed paths are refused.",
  permissions:
    "Existing private roots and environment parents must be owned by this account with mode 0700. Setup never repairs existing permissions.",
  exists:
    "A managed directory or environment file already exists. Existing files were preserved; choose fresh paths.",
  token:
    "The token file must be an owned regular 0600 file in a private directory, with no symlinks or hard links, containing one nonempty token line.",
  configuration:
    "Configuration was rejected. Check Discord IDs and selected runner settings; no credentials or raw diagnostics are printed.",
  opencode:
    "OpenCode requires --opencode-model provider/model and separate --allow-opencode-host-execution consent with operator-managed isolation.",
  container:
    "This container only supports its packaged runner. Use a Linux host installation for other experimental adapters.",
  cancelled:
    "Setup cancelled. No account login or service start was attempted.",
  failed:
    "Setup failed. Newly created setup files were rolled back; existing resources were preserved.",
  rollback:
    "Setup failed and cleanup could not safely finish. Inspect the chosen private paths before retrying; existing or changed files were preserved.",
};
export class SetupError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.failed);
    this.code = code;
  }
}
const fail = (code) => {
  throw new SetupError(code);
};
const inside = (parent, child) =>
  child === parent || child.startsWith(parent + sep);
const uid = () => process.getuid?.();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}
export function serializeEnvironment(env) {
  return (
    "# Private Szpont configuration. Load only as the dedicated service account.\n" +
    Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join("\n") +
    "\n"
  );
}
function privatePath(input) {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    /[\x00-\x1f\x7f]/.test(input)
  )
    fail("path");
  const path = resolve(input);
  if (
    path === parse(path).root ||
    inside(sourceRoot, path) ||
    inside(path, sourceRoot)
  )
    fail("path");
  return path;
}
async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
// Inspect each existing ancestor without following an alias. Root-owned sticky
// temporary parents are allowed; writable nonsticky or foreign-owned parents are not.
async function inspectAncestors(path) {
  const root = parse(path).root;
  let current = root;
  let last = { path: root, info: await lstat(root) };
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await metadata(current);
    if (!info) break;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, uid()].includes(info.uid) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && info.mode & 0o1000))
    )
      fail("path");
    last = { path: current, info };
  }
  return last;
}
function requirePrivate(info) {
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o700
  )
    fail("permissions");
}
async function readToken(path) {
  try {
    path = privatePath(path);
    await inspectAncestors(dirname(path));
    requirePrivate(await metadata(dirname(path)));
    const info = await metadata(path);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== uid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 4098
    )
      fail("token");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(info, await file.stat())) fail("token");
      const bytes = Buffer.alloc(4099);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await file.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > 4098 || (await file.stat()).size !== info.size)
        fail("token");
      const token = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, bytesRead))
        .replace(/\r?\n$/, "");
      return validateToken(token);
    } finally {
      await file.close();
    }
  } catch {
    fail("token");
  }
}
function validateToken(token) {
  if (
    typeof token !== "string" ||
    !token ||
    Buffer.byteLength(token, "utf8") > 4096 ||
    /[\x00-\x1f\x7f]/.test(token)
  )
    fail("token");
  return token;
}
async function compiledLoader() {
  try {
    return (
      await import(
        new URL("../apps/discord-agent/dist/config.js", import.meta.url)
      )
    ).loadConfig;
  } catch {
    fail("build");
  }
}
async function initializeWorkspace(path) {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  await execute(
    process.execPath,
    [join(sourceRoot, "scripts/init-workspace.mjs"), path],
    {
      env,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
}

/** Create only fresh managed resources. Never log the token or return its value. */
export async function setup(options, dependencies = {}) {
  if (!["linux", "darwin"].includes(process.platform)) fail("platform");
  if (!process.versions.node.startsWith("24.")) fail("node");
  const root = privatePath(
    options.root ?? join(homedir(), ".local/share/szpont"),
  );
  const envFile = privatePath(options.envFile ?? join(root, "agent.env"));
  const runner = options.runner ?? "codex";
  if (!["codex", "claude", "opencode"].includes(runner)) fail("configuration");
  if (
    process.env.SZPONT_CONTAINER_RUNNER &&
    runner !== process.env.SZPONT_CONTAINER_RUNNER
  )
    fail("container");
  if (
    runner === "opencode" &&
    (!options.opencodeModel || options.allowOpencodeHostExecution !== true)
  )
    fail("opencode");
  const paths = Object.fromEntries(
    directories.map((name) => [name, join(root, name)]),
  );
  if (
    Object.values(paths).some(
      (path) => inside(path, envFile) || inside(envFile, path),
    )
  )
    fail("path");
  const rootParent = await inspectAncestors(root);
  if (rootParent.path === root) requirePrivate(rootParent.info);
  else if (rootParent.info.uid !== uid()) fail("permissions");
  await inspectAncestors(dirname(envFile));
  const envParent = await metadata(dirname(envFile));
  if (envParent) requirePrivate(envParent);
  for (const path of [...Object.values(paths), envFile])
    if (await metadata(path)) fail("exists");
  const loadConfig = dependencies.loadConfig ?? (await compiledLoader());
  const token = options.tokenFile
    ? await readToken(options.tokenFile)
    : validateToken(options.hiddenToken);
  const env = {
    DISCORD_BOT_TOKEN: token,
    SZPONT_DISCORD_GUILD_ID: options.guildId,
    SZPONT_DISCORD_OWNER_ID: options.ownerId,
    SZPONT_DISCORD_BOT_ID: options.botId,
    SZPONT_DISCORD_PARENT_CHANNEL_ID: options.forumId,
    SZPONT_WORKSPACE: paths.workspace,
    SZPONT_STATE_DIR: paths.state,
    SZPONT_ARTIFACTS_DIR: paths.artifacts,
    SZPONT_BROWSER_DIR: paths.browser,
    CODEX_HOME: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claude,
    SZPONT_OPENCODE_HOME: paths.opencode,
    GH_CONFIG_DIR: paths.github,
    SZPONT_RUNNER: runner,
    SZPONT_CODEX_BIN: "codex",
    SZPONT_CLAUDE_BIN: "claude",
    SZPONT_OPENCODE_BIN: "opencode",
    SZPONT_TASK_TIMEOUT_MS: "1200000",
    ...(runner === "claude"
      ? { SZPONT_CLAUDE_MODEL: "sonnet", SZPONT_CLAUDE_EFFORT: "high" }
      : {}),
    ...(runner === "opencode"
      ? {
          SZPONT_OPENCODE_MODEL: options.opencodeModel,
          SZPONT_OPENCODE_HOST_EXECUTION: "allow",
        }
      : {}),
  };
  try {
    loadConfig({
      ...env,
      ...(process.env.SZPONT_CONTAINER_RUNNER
        ? { SZPONT_CONTAINER_RUNNER: process.env.SZPONT_CONTAINER_RUNNER }
        : {}),
    });
  } catch {
    fail("configuration");
  }
  const created = [];
  let unprovenWorkspace = false;
  async function record(path, recursive = false) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail("path");
    created.push({ path, info, recursive });
  }
  async function makeParents(path) {
    const info = await metadata(path);
    if (info) {
      await inspectAncestors(path);
      return;
    }
    await makeParents(dirname(path));
    await mkdir(path, { mode: 0o700 });
    await record(path);
    await chmod(path, 0o700);
  }
  async function rollback() {
    let ok = true;
    for (const item of created.toReversed()) {
      try {
        const actual = await metadata(item.path);
        if (!actual) continue;
        if (!same(actual, item.info) || actual.isSymbolicLink()) {
          ok = false;
          continue;
        }
        if (actual.isFile()) await rm(item.path);
        else if (item.recursive) await rm(item.path, { recursive: true });
        else await rmdir(item.path); // Never remove an unexpected new file in a parent.
      } catch {
        ok = false;
      }
    }
    return ok;
  }
  try {
    await makeParents(root);
    requirePrivate(await lstat(root));
    await makeParents(dirname(envFile));
    requirePrivate(await lstat(dirname(envFile)));
    const parents = await Promise.all(
      [root, dirname(envFile)].map(async (path) => ({
        path,
        info: await lstat(path),
      })),
    );
    const checkParents = async () => {
      for (const parent of parents) {
        const actual = await lstat(parent.path);
        if (!same(actual, parent.info)) fail("path");
        requirePrivate(actual);
        await inspectAncestors(parent.path);
      }
    };
    // Recheck every destination immediately before mutation under the private root.
    for (const path of [...Object.values(paths), envFile])
      if (await metadata(path)) fail("exists");
    try {
      await (dependencies.initializeWorkspace ?? initializeWorkspace)(
        paths.workspace,
      );
    } catch (error) {
      await checkParents();
      // A failed exclusive initializer may have lost a race to another owner.
      // Existence/UID alone cannot prove this invocation created the workspace.
      unprovenWorkspace = Boolean(await metadata(paths.workspace));
      throw error;
    }
    await checkParents();
    await record(paths.workspace, true);
    for (const path of Object.values(paths).filter(
      (path) => path !== paths.workspace,
    )) {
      await checkParents();
      await mkdir(path, { mode: 0o700 });
      await record(path);
      await chmod(path, 0o700);
    }
    await checkParents();
    const file = await open(
      envFile,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      created.push({
        path: envFile,
        info: await file.stat(),
        recursive: false,
      });
      await file.chmod(0o600);
      await file.writeFile(serializeEnvironment(env));
      await file.sync();
    } finally {
      await file.close();
    }
    return { root, envFile, runner };
  } catch {
    const rolledBack = await rollback();
    fail(rolledBack && !unprovenWorkspace ? "failed" : "rollback");
  }
}

export const usage = `Usage: node scripts/setup.mjs [options]
Guided private setup; installs no runner, account, service or browser and performs no network checks.
Build first with npm run build. Linux is the supported deployment host.

  --root /absolute/private/szpont  Default: ~/.local/share/szpont
  --env-file /absolute/agent.env   Default: ROOT/agent.env
  --runner codex|claude|opencode   Default: codex; other adapters are experimental Linux host integrations
  --guild-id ID --owner-id ID --bot-id ID --forum-id ID
  --token-file /absolute/token    Existing owned regular 0600 file in a private directory; token is never an argv value
  --token-stdin                   Read at most 4096 token bytes from a pipe, optionally followed by one newline; exclusive with --token-file
  --opencode-model provider/model --allow-opencode-host-execution
  --yes                           Confirm file creation; required without an interactive terminal
  --help                          Show this help

Missing fields are prompted only in a terminal. Token input is hidden.
Existing managed directories/files and unsafe paths are never overwritten or repaired.`;
export function parseSetupArguments(args) {
  const options = {};
  const values = new Map([
    ["--root", "root"],
    ["--env-file", "envFile"],
    ["--runner", "runner"],
    ["--guild-id", "guildId"],
    ["--owner-id", "ownerId"],
    ["--bot-id", "botId"],
    ["--forum-id", "forumId"],
    ["--token-file", "tokenFile"],
    ["--opencode-model", "opencodeModel"],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = values.get(arg);
    if (key) {
      if (
        options[key] !== undefined ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        fail("arguments");
      options[key] = args[++i];
    } else if (
      arg === "--yes" ||
      arg === "--allow-opencode-host-execution" ||
      arg === "--help" ||
      arg === "--token-stdin"
    ) {
      const key = {
        "--yes": "yes",
        "--allow-opencode-host-execution": "allowOpencodeHostExecution",
        "--help": "help",
        "--token-stdin": "tokenStdin",
      }[arg];
      if (options[key]) fail("arguments");
      options[key] = true;
    } else fail("arguments");
  }
  if (options.tokenFile && options.tokenStdin) fail("arguments");
  return options;
}
export function readTokenStdin(input = process.stdin) {
  if (input.isTTY) fail("confirmation");
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0,
      done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", data);
      input.off("end", end);
      input.off("error", bad);
      input.off("close", closed);
      input.pause();
      if (error) {
        reject(new SetupError("token"));
        return;
      }
      try {
        const token = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, size))
          .replace(/\r?\n$/, "");
        resolvePromise(validateToken(token));
      } catch {
        reject(new SetupError("token"));
      }
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 4098) return finish(true);
      chunks.push(bytes);
    };
    const end = () => finish(false),
      bad = () => finish(true);
    const closed = () => {
      if (!input.readableEnded) finish(true);
    };
    const timer = setTimeout(bad, 30_000);
    input.on("data", data);
    input.once("end", end);
    input.once("error", bad);
    input.once("close", closed);
    input.resume();
  });
}
export function readHiddenToken(
  input = process.stdin,
  output = process.stdout,
) {
  if (!input.isTTY || typeof input.setRawMode !== "function")
    fail("confirmation");
  const wasRaw = input.isRaw,
    wasPaused = input.isPaused();
  return new Promise((resolvePromise, reject) => {
    let value = "",
      finished = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.off("data", data);
      input.off("end", end);
      input.off("error", end);
      process.off("SIGTERM", end);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      output.write("\n");
      error ? reject(new SetupError(error)) : resolvePromise(value);
    };
    const end = () => finish("cancelled");
    const data = (chunk) => {
      for (const char of decoder.write(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      )) {
        if (char === "\u0003" || char === "\u0004") return finish("cancelled");
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b")
          value = [...value].slice(0, -1).join("");
        else value += char;
        if (Buffer.byteLength(value, "utf8") > 4096) return finish("token");
      }
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", end);
    process.once("SIGTERM", end);
    try {
      input.setRawMode(true);
      input.resume();
      output.write("Discord bot token (hidden): ");
    } catch {
      finish("cancelled");
    }
  });
}
async function guided(options) {
  const complete = ["guildId", "ownerId", "botId", "forumId"].every(
    (key) => options[key],
  );
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (options.tokenStdin && process.stdin.isTTY) fail("confirmation");
  if (!interactive) {
    if (
      !options.yes ||
      !complete ||
      (!options.tokenFile && !options.tokenStdin)
    )
      fail("confirmation");
    if (options.tokenStdin) options.hiddenToken = await readTokenStdin();
    return options;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!options.root)
      options.root =
        (await rl.question(
          `Private root [${join(homedir(), ".local/share/szpont")}]: `,
        )) || join(homedir(), ".local/share/szpont");
    if (!options.runner)
      options.runner =
        (await rl.question(
          "Runner [codex; claude/opencode are experimental Linux integrations]: ",
        )) || "codex";
    for (const [key, prompt] of [
      ["guildId", "Discord server ID"],
      ["ownerId", "Your Discord user ID"],
      ["botId", "Bot application user ID"],
      ["forumId", "Private forum channel ID"],
    ])
      if (!options[key]) options[key] = await rl.question(prompt + ": ");
    if (options.runner === "opencode") {
      if (!options.opencodeModel)
        options.opencodeModel = await rl.question("OpenCode provider/model: ");
      if (!options.allowOpencodeHostExecution)
        options.allowOpencodeHostExecution =
          (
            await rl.question(
              "OpenCode executes with this account's host permissions. Have you provisioned isolation and allow it? [y/N]: ",
            )
          ).toLowerCase() === "y";
    }
    if (
      !options.yes &&
      (
        await rl.question(
          "Create fresh private configuration and workspace? [y/N]: ",
        )
      ).toLowerCase() !== "y"
    )
      fail("cancelled");
  } finally {
    rl.close();
  }
  if (!options.tokenFile) options.hiddenToken = await readHiddenToken();
  return options;
}
export function nextSteps({ envFile, runner }) {
  const auth =
    runner === "claude"
      ? "claude auth login"
      : runner === "opencode"
        ? "opencode auth login"
        : "codex login";
  return `Private setup complete. No account was logged in, service started, network checked or runner installed.
Edit agent/USER.md and agent/POLICY.md in the private workspace before authorizing tasks.
Install the documented runner and Linux prerequisites separately; see docs/runners.md.
Run as this dedicated account, from this source checkout:

set -a
. ${shellQuote(envFile)}
set +a
${runner === "opencode" ? 'env HOME="$SZPONT_OPENCODE_HOME" XDG_CONFIG_HOME="$SZPONT_OPENCODE_HOME/config" XDG_DATA_HOME="$SZPONT_OPENCODE_HOME/data" XDG_STATE_HOME="$SZPONT_OPENCODE_HOME/state" XDG_CACHE_HOME="$SZPONT_OPENCODE_HOME/cache" ' : ""}${auth}
npm run doctor -- --check-login
# Explicit read-only Discord permission check; contacts Discord using the bot token:
npm run doctor -- --check-discord
# Start only after prerequisite checks and private-forum permissions are reviewed:
flock -n -E 75 "$SZPONT_STATE_DIR/engine.lock" npm --prefix apps/discord-agent start

Claude/OpenCode remain experimental host adapters; the published Docker image is Codex-only.
Runtime security findings remain in SECURITY.md; successful setup is not deployment acceptance.`;
}
async function main() {
  try {
    const options = parseSetupArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
      return;
    }
    console.log(nextSteps(await setup(await guided(options))));
  } catch (error) {
    console.error(
      "Setup: " +
        (error instanceof SetupError ? error.message : messages.failed),
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
