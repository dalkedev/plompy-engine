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
  publicRoot = sourceRoot,
  checkLogin = false,
} = {}) {
  const checks = [];
  const dependentChecks = [...baseDependentChecks];
  const add = (id, status, message, required = true) => {
    checks.push({ id, status, required, message });
  };
  const skip = (ids, message) => {
    for (const id of ids)
      add(id, "NOT_RUN", message, !id.endsWith("_login") || checkLogin);
  };
  add(
    "node_runtime",
    /^24\./.test(nodeVersion) ? "PASS" : "FAIL",
    /^24\./.test(nodeVersion)
      ? "Node 24 is available."
      : "Use Node 24 to run the engine and its checks.",
  );

  let config, childEnvironment;
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
    add(
      "configuration",
      "FAIL",
      "Build the engine, then load a trusted private environment file with every required value.",
    );
    skip(dependentChecks, "Configuration is unavailable or invalid.");
    return report(checks);
  }
  add(
    "configuration",
    "PASS",
    "The compiled configuration loader accepts the required values and identity formats.",
  );

  let canonicalRoot, paths;
  try {
    canonicalRoot = await realpath(publicRoot);
    if (
      env.SZPONT_BROWSER_DIR !== undefined &&
      !isAbsolute(env.SZPONT_BROWSER_DIR)
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
    return report(checks);
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
    return report(checks);
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
        : "OpenCode needs operator-managed isolation and explicit SZPONT_OPENCODE_HOST_EXECUTION=allow. See the runner guide.",
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
  return report(checks);
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
    args.some((arg) => !["--json", "--check-login", "--help"].includes(arg))
  ) {
    const invalid = report([
      {
        id: "arguments",
        status: "FAIL",
        required: true,
        message: "Use --json, --check-login, or --help.",
      },
    ]);
    console.log(formatReport(invalid, json));
    process.exitCode = 1;
    return;
  }
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/doctor.mjs [--json] [--check-login]\nDefault: offline prerequisite inspection with no repairs or login check.",
    );
    return;
  }
  const result = await runDoctor({
    checkLogin: args.includes("--check-login"),
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
