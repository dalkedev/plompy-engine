import { normalizeEnvironment } from "./brand-compat.mjs";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const configModule = new URL(
  "../apps/discord-agent/dist/config.js",
  import.meta.url,
);
const runtimeModule = new URL(
  "../apps/discord-agent/dist/node-runtime.js",
  import.meta.url,
);
const expectedCodex = "0.166.0";
const pathKeys = ["workspace", "stateDir", "artifactsDir", "browserDir"];
const baseDependentChecks = [
  "path_separation",
  "private_directories",
  "private_writability",
  "workspace_git",
  "codex_version",
  "codex_login",
];
const discordChecks = [
  "discord_bot_identity",
  "discord_guild_owner",
  "discord_private_forum",
  "discord_bot_permissions",
];
const discordApi = "https://discord.com/api/v10";
const discordBodyLimit = 1024 * 1024;
const viewChannel = 1n << 10n;
const administrator = 1n << 3n;
const threadReplyPermissions =
  viewChannel | (1n << 15n) | (1n << 16n) | (1n << 38n);

class DiscordInspectionError extends Error {}

function invalidDiscordResponse() {
  throw new DiscordInspectionError(
    "Discord returned an unsupported response; no request was retried.",
  );
}

function discordBits(value) {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value))
    invalidDiscordResponse();
  return BigInt(value);
}

const discordId = (value) =>
  typeof value === "string" && /^\d{17,20}$/.test(value);

/** Explicit REST inspection only: no Gateway, model, message or configuration writes. */
export async function runDiscordChecks({
  config,
  enabled = false,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 5_000,
  totalTimeoutMs = 15_000,
} = {}) {
  const checks = [];
  const remaining = (reason) => {
    for (const id of discordChecks.slice(checks.length))
      checks.push({
        id,
        status: "NOT_RUN",
        required: enabled,
        message: reason,
      });
    return checks;
  };
  if (!enabled)
    return remaining(
      "Discord REST inspection requires --check-discord; no network request was made.",
    );
  if (!config)
    return remaining(
      "Valid local configuration is required before Discord REST inspection.",
    );

  // Tests may shorten these bounds, but callers cannot expand the network budget.
  const requestLimit = Math.min(Math.max(requestTimeoutMs, 1), 5_000);
  const deadline =
    performance.now() + Math.min(Math.max(totalTimeoutMs, 1), 15_000);
  const get = async (path) => {
    const controller = new AbortController();
    let timer, reader;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(
            new DiscordInspectionError(
              "Discord read failed or timed out; no request was retried.",
            ),
          );
        },
        Math.max(1, Math.min(requestLimit, deadline - performance.now())),
      );
    });
    const read = async () => {
      if (performance.now() >= deadline) throw new Error("inspection deadline");
      const response = await fetchImpl(discordApi + path, {
        method: "GET",
        headers: {
          Authorization: `Bot ${config.token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error("inspection deadline");
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        const message = {
          401: "Discord rejected bot authorization; check the private token.",
          403: "Discord denied this read; check bot membership and access.",
          404: "Discord resource is unavailable; check the configured identities.",
          429: "Discord rate limited this inspection; no request was retried.",
        }[response.status];
        throw new DiscordInspectionError(
          message ?? "Discord read was unavailable; no request was retried.",
        );
      }
      const length = response.headers.get("content-length");
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > discordBodyLimit)
      ) {
        void response.body?.cancel().catch(() => {});
        invalidDiscordResponse();
      }
      if (!response.body) invalidDiscordResponse();
      reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > discordBodyLimit) invalidDiscordResponse();
          chunks.push(value);
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
    try {
      return await Promise.race([read(), expired]);
    } catch (error) {
      if (error instanceof DiscordInspectionError) throw error;
      throw new DiscordInspectionError(
        "Discord read failed or timed out; no request was retried.",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };
  const check = async (id, inspect, message) => {
    try {
      await inspect();
      checks.push({ id, status: "PASS", required: true, message });
      return true;
    } catch (error) {
      checks.push({
        id,
        status: "FAIL",
        required: true,
        message:
          error instanceof DiscordInspectionError
            ? error.message
            : "Discord inspection could not establish this prerequisite.",
      });
      return false;
    }
  };
  let guild, roles, overwrites;
  if (
    !(await check(
      discordChecks[0],
      async () => {
        const bot = await get("/users/@me");
        if (bot?.id !== config.botId || bot.bot !== true)
          throw new DiscordInspectionError(
            "The token does not identify the configured bot.",
          );
      },
      "Discord REST identifies the configured bot account.",
    ))
  )
    return remaining(
      "Bot identity was not verified; dependent Discord reads were not made.",
    );
  if (
    !(await check(
      discordChecks[1],
      async () => {
        guild = await get(`/guilds/${config.guildId}`);
        if (guild?.id !== config.guildId || guild.owner_id !== config.ownerId)
          throw new DiscordInspectionError(
            "The configured server owner does not match Discord.",
          );
      },
      "Discord REST confirms the configured server owner.",
    ))
  )
    return remaining(
      "Server ownership was not verified; dependent Discord reads were not made.",
    );
  if (
    !(await check(
      discordChecks[2],
      async () => {
        const forum = await get(`/channels/${config.parentId}`);
        if (
          forum?.id !== config.parentId ||
          forum.type !== 15 ||
          forum.guild_id !== config.guildId
        )
          throw new DiscordInspectionError(
            "The configured channel is not a forum in the configured server.",
          );
        if (
          !Array.isArray(guild.roles) ||
          !Array.isArray(forum.permission_overwrites)
        )
          invalidDiscordResponse();
        roles = new Map();
        for (const role of guild.roles) {
          if (!discordId(role?.id) || roles.has(role.id))
            invalidDiscordResponse();
          roles.set(role.id, discordBits(role.permissions));
        }
        const everyone = roles.get(config.guildId);
        if (everyone === undefined) invalidDiscordResponse();
        const ids = new Set();
        overwrites = forum.permission_overwrites.map((overwrite) => {
          if (
            !discordId(overwrite?.id) ||
            ![0, 1].includes(overwrite.type) ||
            ids.has(overwrite.id)
          )
            invalidDiscordResponse();
          ids.add(overwrite.id);
          return {
            id: overwrite.id,
            type: overwrite.type,
            allow: discordBits(overwrite.allow),
            deny: discordBits(overwrite.deny),
          };
        });
        // Mirror DiscordTransport.validate(): @everyone's effective role permissions,
        // then every explicit ViewChannel grant, including role overwrites.
        const everyoneOverwrite = overwrites.find(
          (o) => o.id === config.guildId && o.type === 0,
        );
        const everyoneEffective =
          (everyone & ~(everyoneOverwrite?.deny ?? 0n)) |
          (everyoneOverwrite?.allow ?? 0n);
        if (everyone & administrator || everyoneEffective & viewChannel)
          throw new DiscordInspectionError(
            "The forum is visible to everyone; restrict forum visibility.",
          );
        if (
          overwrites.some(
            (o) =>
              o.allow & viewChannel &&
              ![config.ownerId, config.botId].includes(o.id),
          )
        )
          throw new DiscordInspectionError(
            "The forum grants additional explicit readers; restrict its visibility.",
          );
      },
      "The forum matches startup privacy checks; server administrators can still access it.",
    ))
  )
    return remaining(
      "Forum privacy was not verified; bot member permissions were not read.",
    );
  await check(
    discordChecks[3],
    async () => {
      const member = await get(
        `/guilds/${config.guildId}/members/${config.botId}`,
      );
      if (
        member?.user?.id !== config.botId ||
        !Array.isArray(member.roles) ||
        member.roles.some((id) => !discordId(id) || !roles.has(id))
      )
        invalidDiscordResponse();
      const roleIds = new Set([config.guildId, ...member.roles]);
      let effective = [...roleIds].reduce(
        (bits, id) => bits | roles.get(id),
        0n,
      );
      if (!(effective & administrator)) {
        const everyone = overwrites.find(
          (o) => o.id === config.guildId && o.type === 0,
        );
        effective =
          (effective & ~(everyone?.deny ?? 0n)) | (everyone?.allow ?? 0n);
        let deny = 0n,
          allow = 0n;
        for (const overwrite of overwrites) {
          if (
            overwrite.type === 0 &&
            overwrite.id !== config.guildId &&
            roleIds.has(overwrite.id)
          ) {
            deny |= overwrite.deny;
            allow |= overwrite.allow;
          }
        }
        effective = (effective & ~deny) | allow;
        const bot = overwrites.find(
          (o) => o.id === config.botId && o.type === 1,
        );
        effective = (effective & ~(bot?.deny ?? 0n)) | (bot?.allow ?? 0n);
        if ((effective & threadReplyPermissions) !== threadReplyPermissions)
          throw new DiscordInspectionError(
            "The bot needs View Channel, Send Messages in Threads, Read Message History and Attach Files in the forum.",
          );
      }
    },
    "Bot REST permissions cover thread replies, history and attachments; Gateway intents and live delivery were not tested.",
  );
  return checks;
}

function overlaps(left, right) {
  const inside = (parent, child) => {
    const part = relative(parent, child);
    return (
      part === "" ||
      (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    );
  };
  return inside(left, right) || inside(right, left);
}

// Resolve existing symlink ancestors even when the final directory is missing.
async function canonicalDestination(input) {
  let ancestor = resolve(input);
  const missing = [];
  for (;;) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

async function command(binary, args, options) {
  return execute(binary, args, {
    ...options,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
}

function report(checks) {
  return {
    schemaVersion: 1,
    ok: !checks.some((check) => check.required && check.status === "FAIL"),
    checks,
  };
}

/** Inspect deployment prerequisites without creating or repairing deployment state. */
export async function runDoctor({
  env = process.env,
  nodeVersion = process.versions.node,
  sqliteVersion = process.versions.sqlite,
  querySQLiteVersion,
  publicRoot = sourceRoot,
  checkLogin = false,
  checkDiscord = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  env = normalizeEnvironment(env);
  const checks = [];
  let config, childEnvironment;
  const finish = async () =>
    report([
      ...checks,
      ...(await runDiscordChecks({ config, enabled: checkDiscord, fetchImpl })),
    ]);
  const dependentChecks = [...baseDependentChecks];
  const add = (id, status, message, required = true) => {
    checks.push({ id, status, required, message });
  };
  const skip = (ids, message) => {
    for (const id of ids)
      add(id, "NOT_RUN", message, !id.endsWith("_login") || checkLogin);
  };
  let runtimeReady = false;
  try {
    const { inspectRuntime } = await import(runtimeModule.href);
    const runtime = inspectRuntime({
      nodeVersion,
      sqliteVersion,
      querySQLiteVersion,
    });
    add("node_runtime", runtime.node.status, runtime.node.message);
    add("sqlite_runtime", runtime.sqlite.status, runtime.sqlite.message);
    runtimeReady =
      runtime.node.status === "PASS" && runtime.sqlite.status === "PASS";
  } catch {
    add(
      "node_runtime",
      "FAIL",
      "Build the engine before inspecting its supported runtime policy.",
    );
    add(
      "sqlite_runtime",
      "NOT_RUN",
      "The linked SQLite runtime policy is unavailable; no filesystem database was opened.",
    );
  }

  let provider = "codex";
  let versionId = "codex_version",
    loginId = "codex_login";
  let activePathKeys = pathKeys;
  try {
    const compiled = await import(configModule.href);
    config = compiled.loadConfig(env);
    childEnvironment = compiled.childEnvironment;
    provider = config.provider ?? "codex";
    versionId = `${provider}_version`;
    loginId = `${provider}_login`;
    dependentChecks.splice(-2, 2, versionId, loginId);
    activePathKeys = [
      ...pathKeys,
      { codex: "codexHome", claude: "claudeHome", opencode: "opencodeHome" }[
        provider
      ],
    ];
  } catch {
    config = undefined;
    add(
      "configuration",
      "FAIL",
      "Build the engine, then load a trusted private environment file with every required value.",
    );
    skip(dependentChecks, "Configuration is unavailable or invalid.");
    return finish();
  }
  add(
    "configuration",
    "PASS",
    "The compiled configuration loader accepts the required values and identity formats.",
  );
  if (!runtimeReady) {
    config = undefined;
    skip(
      dependentChecks,
      "Supported Node and linked SQLite runtime checks must pass first.",
    );
    return finish();
  }

  let canonicalRoot, paths;
  try {
    canonicalRoot = await realpath(publicRoot);
    if (
      env.PLOMPY_BROWSER_DIR !== undefined &&
      !isAbsolute(env.PLOMPY_BROWSER_DIR)
    )
      throw new Error("relative browser directory");
    paths = await Promise.all(
      activePathKeys.map((key) => canonicalDestination(config[key])),
    );
    if (paths.some((path) => overlaps(canonicalRoot, path)))
      throw new Error("public source overlap");
    if (
      paths.some((path, index) =>
        paths.slice(index + 1).some((other) => overlaps(path, other)),
      )
    )
      throw new Error("private directory overlap");
  } catch {
    add(
      "path_separation",
      "FAIL",
      "Use distinct absolute private directories outside the public source tree; check symlinks and ancestor overlaps.",
    );
    skip(
      dependentChecks.slice(1),
      "Private directory separation could not be established.",
    );
    return finish();
  }
  add(
    "path_separation",
    "PASS",
    "Private directories are separate from one another and the public source tree, including existing symlink aliases.",
  );

  let directoriesReady = true;
  try {
    for (const path of paths) {
      if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    }
  } catch {
    directoriesReady = false;
  }
  add(
    "private_directories",
    directoriesReady ? "PASS" : "FAIL",
    directoriesReady
      ? "All configured private directories already exist."
      : "Create every configured private directory as the service user before starting the engine.",
  );
  if (!directoriesReady) {
    skip(
      dependentChecks.slice(2),
      "One or more private directories are missing or inaccessible.",
    );
    return finish();
  }

  try {
    for (const path of paths)
      await access(path, constants.W_OK | constants.X_OK);
    add(
      "private_writability",
      "PASS",
      "The current user can write and traverse every private directory; no write probe was performed.",
    );
  } catch {
    add(
      "private_writability",
      "FAIL",
      "Grant the service user write and traversal access to the private directories; this command does not change permissions.",
    );
  }

  // Match the engine's child allowlist; never pass the Discord token or arbitrary
  // GIT_* variables to a diagnostic subprocess.
  const childEnv = childEnvironment(config, env);
  const gitEnv = {
    ...childEnv,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args) => {
    const result = await command(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        cwd: config.workspace,
        env: gitEnv,
      },
    );
    return result.stdout.trim();
  };
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true")
      throw new Error("not a work tree");
    const top = await realpath(await git(["rev-parse", "--show-toplevel"]));
    if (top !== paths[0]) throw new Error("inherited parent repository");
    for (const option of ["--absolute-git-dir", "--git-common-dir"]) {
      const metadata = await realpath(
        resolve(config.workspace, await git(["rev-parse", option])),
      );
      if (overlaps(canonicalRoot, metadata))
        throw new Error("public git metadata");
      await access(metadata, constants.W_OK | constants.X_OK);
    }
    add(
      "workspace_git",
      "PASS",
      "The workspace is a Git work tree at its configured root with writable private Git metadata.",
    );
  } catch {
    add(
      "workspace_git",
      "FAIL",
      "Initialize an independent private Git workspace at its configured root and make its Git metadata writable by the service user.",
    );
  }

  const binary = {
    codex: config.codexBin,
    claude: config.claudeBin,
    opencode: config.opencodeBin,
  }[provider];
  const versions = {
    codex: `Codex CLI ${expectedCodex}`,
    claude: "Claude Code >=2.1.285, <3",
    opencode: "OpenCode 1.19.5",
  };
  let versionReady = false;
  try {
    const result = await command(binary, ["--version"], {
      cwd: config.workspace,
      env: childEnv,
    });
    const output = result.stdout.trim();
    if (provider === "codex")
      versionReady = output === `codex-cli ${expectedCodex}`;
    else if (provider === "opencode") versionReady = output === "1.19.5";
    else {
      const { supportedClaudeVersion } = await import(
        new URL("../apps/discord-agent/dist/claude.js", import.meta.url)
      );
      versionReady = supportedClaudeVersion(output);
    }
  } catch {
    /* Do not disclose account or subprocess diagnostics. */
  }
  add(
    versionId,
    versionReady ? "PASS" : "FAIL",
    versionReady
      ? `The configured executable meets the adapter requirement: ${versions[provider]}.`
      : `Install ${versions[provider]} and verify the selected runner binary; other protocols are not validated.`,
  );
  if (provider === "opencode")
    add(
      "opencode_host_execution",
      config.opencodeAllowHostExecution ? "PASS" : "FAIL",
      config.opencodeAllowHostExecution
        ? "Operator explicitly enabled host execution. OpenCode has no engine-provided OS sandbox; verify your own isolation."
        : "OpenCode needs operator-managed isolation and explicit PLOMPY_OPENCODE_HOST_EXECUTION=allow. See the runner guide.",
    );

  if (!checkLogin) {
    add(
      loginId,
      "NOT_RUN",
      "Readiness is inspected only with --check-login; account access was not tested.",
      false,
    );
  } else if (!versionReady) {
    add(
      loginId,
      "NOT_RUN",
      "The selected runner version check must pass first.",
    );
  } else {
    let ready = false;
    try {
      if (provider === "codex") {
        await command(binary, ["login", "status"], {
          cwd: config.workspace,
          env: childEnv,
        });
        ready = true;
      } else {
        const adapter = await import(
          new URL(`../apps/discord-agent/dist/${provider}.js`, import.meta.url)
        );
        ready = await adapter[
          provider === "claude" ? "claudeReady" : "opencodeReady"
        ](config, env);
      }
    } catch {
      /* Keep private readiness details out of diagnostics. */
    }
    add(
      loginId,
      ready ? "PASS" : "FAIL",
      provider === "opencode"
        ? ready
          ? "Local OpenCode model configuration and credential entry are present; remote authorization and model access were not tested."
          : "Check the private OpenCode configuration, selected model credentials, pinned CLI and host execution opt-in."
        : ready
          ? `${provider === "claude" ? "Claude Code" : "Codex"} local login status succeeded for the selected private configuration.`
          : "Complete the selected CLI login separately as the service user with its private configuration directory, then retry.",
    );
  }
  return finish();
}

export function formatReport(result, json = false) {
  if (json) return JSON.stringify(result, null, 2);
  return result.checks
    .map(({ id, status, message }) => `${status} ${id}: ${message}`)
    .join("\n");
}

async function main(args) {
  const json = args.includes("--json");
  if (
    args.some(
      (arg) =>
        !["--json", "--check-login", "--check-discord", "--help"].includes(arg),
    )
  ) {
    const invalid = report([
      {
        id: "arguments",
        status: "FAIL",
        required: true,
        message: "Use --json, --check-login, --check-discord, or --help.",
      },
    ]);
    console.log(formatReport(invalid, json));
    process.exitCode = 1;
    return;
  }
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/doctor.mjs [--json] [--check-login] [--check-discord]\nDefault: offline prerequisite inspection with no repairs or login check.\n--check-discord: bounded read-only Discord REST inspection; no Gateway, messages or model calls.",
    );
    return;
  }
  const result = await runDoctor({
    checkLogin: args.includes("--check-login"),
    checkDiscord: args.includes("--check-discord"),
  });
  console.log(formatReport(result, json));
  process.exitCode = result.ok ? 0 : 1;
}

const invokedAsScript =
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).then(
    (path) => pathToFileURL(path).href === import.meta.url,
    () => false,
  ));
if (invokedAsScript) {
  await main(process.argv.slice(2)).catch(() => {
    // Keep unexpected failure output as restrictive as ordinary diagnostics.
    console.log(
      formatReport(
        report([
          {
            id: "doctor",
            status: "FAIL",
            required: true,
            message:
              "Inspection could not complete; verify the build and private deployment prerequisites.",
          },
        ]),
        process.argv.includes("--json"),
      ),
    );
    process.exitCode = 1;
  });
}
