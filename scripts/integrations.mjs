import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { catalog, playbook } from "./integrations/catalog.mjs";
import { remoteServices, buildServiceEntry } from "./integrations/services.mjs";
import { preparePlaywright } from "./integrations/playwright.mjs";
import {
  inside,
  privateDirectory,
  privatePath,
  readPrivateJson,
  writePrivate,
} from "./integrations/paths.mjs";
import { inspectMcp, registerMcp, unregisterMcp } from "./integrations/mcp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const providers = ["codex", "claude", "opencode"];
const runnerNames = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode (Go, Zen, or another configured provider)",
};
const managedMarker = "<!-- Managed by Szpont integrations CLI.";
const help = `Usage: npm run integrations -- [command] [integration] [options]
No command: interactive integration menu (TTY required).
Commands: list, add <id>, status [id], login github, remove <id>
Integrations: github, camoufox, playwright, perplexity, firecrawl, tinyfish, posthog, openai-docs, context7, custom
Options: --runner codex|claude|opencode, --yes, --login (GitHub), --json (list/status), --spec /private/server.json
Browser: --browser-bin /absolute/browser (optional for Playwright; required for Camoufox)
Camoufox: --python /absolute/python --display :99
Remote services: --auth oauth|api-key|keyless (service-dependent), --credential-file /private/credentials/service.key
A credential-file implies api-key authentication. No secret values are accepted as arguments.
Codex Playwright only: --tool-approval approve|prompt (explicit opt-in; --yes does not change tool approval)
Playwright and API-key bridge dependencies require their documented optional npm ci step.
Load the same private deployment environment as the engine and stop it before changes.
--runner chooses which runner's tools to configure; it does not switch existing Discord threads or the service default.
Configuration checks do not contact MCP servers or invoke a model. GitHub status checks authentication.
`;

export async function createContext(env = process.env, publicRoot = root) {
  const workspace = await privatePath(env.SZPONT_WORKSPACE, publicRoot);
  const stateDir = await privatePath(env.SZPONT_STATE_DIR, publicRoot, [
    workspace,
  ]);
  const deploymentState = resolve(env.SZPONT_STATE_DIR);
  const provider = env.SZPONT_RUNNER ?? "codex";
  if (!providers.includes(provider))
    throw new Error("Select SZPONT_RUNNER=codex, claude or opencode.");
  const setting = (key, fallback) => {
    const value = env[key] ?? fallback;
    if (!value || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value))
      throw new Error(`Invalid ${key}.`);
    return value;
  };
  const path = (key, fallback) =>
    privatePath(env[key] ?? fallback, publicRoot, [workspace]);
  const config = {
    workspace,
    stateDir,
    provider,
    artifactsDir: await path(
      "SZPONT_ARTIFACTS_DIR",
      join(deploymentState, "..", "artifacts"),
    ),
    browserDir: await path("SZPONT_BROWSER_DIR", "/var/lib/szpont/browser"),
    githubConfigDir: await path(
      "GH_CONFIG_DIR",
      join(deploymentState, "..", "github"),
    ),
    codexHome: await path("CODEX_HOME", join(deploymentState, "..", "codex")),
    codexBin: setting("SZPONT_CODEX_BIN", "codex"),
    claudeBin: setting("SZPONT_CLAUDE_BIN", "claude"),
    claudeHome: await path(
      "CLAUDE_CONFIG_DIR",
      join(deploymentState, "..", "claude"),
    ),
    opencodeBin: setting("SZPONT_OPENCODE_BIN", "opencode"),
    opencodeHome: await path(
      "SZPONT_OPENCODE_HOME",
      join(deploymentState, "..", "opencode"),
    ),
    publicRoot,
  };
  config.claudeMcpConfig = await path(
    "SZPONT_CLAUDE_MCP_CONFIG",
    join(config.claudeHome, "szpont-mcp.json"),
  );
  config.opencodeConfig = await path(
    "SZPONT_OPENCODE_CONFIG",
    join(config.opencodeHome, "szpont-mcp.json"),
  );
  for (const other of [
    config.stateDir,
    config.codexHome,
    config.claudeHome,
    config.opencodeHome,
  ]) {
    if (
      inside(other, config.githubConfigDir) ||
      inside(config.githubConfigDir, other)
    )
      throw new Error(
        "GitHub credentials need a dedicated directory separate from state and runner authentication directories.",
      );
  }
  const childEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (env[key] !== undefined) childEnv[key] = env[key];
  Object.assign(childEnv, {
    CODEX_HOME: config.codexHome,
    GH_CONFIG_DIR: config.githubConfigDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  });
  if (!(await lstat(workspace)).isDirectory())
    throw new Error("Initialize the private workspace first.");
  return {
    config,
    provider,
    env: childEnv,
    publicRoot,
    manifest: join(stateDir, "integrations.json"),
  };
}

async function registry(ctx) {
  const value = await readPrivateJson(ctx.manifest, {
    schemaVersion: 1,
    integrations: [],
  });
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.integrations) ||
    value.integrations.length > 30
  )
    throw new Error(
      "Unsupported integration manifest; existing files were preserved.",
    );
  const names = new Set();
  for (const e of value.integrations) {
    if (
      !catalog.some((c) => c.id === e.id) ||
      !providers.includes(e.provider) ||
      (e.toolApproval !== undefined &&
        (e.id !== "playwright" ||
          e.provider !== "codex" ||
          !["approve", "prompt"].includes(e.toolApproval))) ||
      (e.id !== "github" && !/^szpont_[a-z0-9_]{1,48}$/.test(e.name)) ||
      names.has(`${e.provider}:${e.name}`)
    )
      throw new Error("Invalid integration manifest.");
    names.add(`${e.provider}:${e.name}`);
  }
  return value;
}

async function saveRegistry(ctx, value) {
  // Dedicated file: preserve hand-written instructions instead of replacing them.
  const agentDir = join(ctx.config.workspace, "agent");
  const folder = await realpath(agentDir);
  if (!inside(await realpath(ctx.config.workspace), folder))
    throw new Error("Agent instructions escaped the workspace.");
  const destination = join(folder, "INTEGRATIONS.md");
  try {
    if (!(await readFile(destination, "utf8")).includes(managedMarker))
      throw new Error(
        "INTEGRATIONS.md already contains operator-written instructions; move it before setup.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writePrivate(ctx.manifest, JSON.stringify(value, null, 2) + "\n");
  await writePrivate(destination, playbook(value.integrations));
}

async function checkInstructionDestination(ctx) {
  const folder = join(ctx.config.workspace, "agent");
  const info = await lstat(folder);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Use a real private agent instructions directory.");
  const path = join(folder, "INTEGRATIONS.md");
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid()) ||
      !(await readFile(path, "utf8")).includes(managedMarker)
    )
      throw new Error(
        "Preserve your existing INTEGRATIONS.md; move it aside before using managed setup.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function withLock(ctx, action) {
  await privateDirectory(ctx.config.stateDir);
  const lock = join(ctx.config.stateDir, "integrations.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another integration setup is running. Inspect a stale integrations.lock before removing it.",
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

async function command(binary, args, options = {}) {
  return exec(binary, args, {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

export async function loginGitHub(ctx, launch = spawn) {
  await privateDirectory(ctx.config.githubConfigDir);
  // gh optionally sets up Git after OAuth. Give that flow its own writable
  // configuration rather than the operator's global config or /dev/null.
  const gitConfig = join(ctx.config.githubConfigDir, "gitconfig");
  const bytes = await readFile(gitConfig, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await writePrivate(gitConfig, bytes);
  const env = { ...ctx.env, GIT_CONFIG_GLOBAL: gitConfig };
  delete env.GH_PROMPT_DISABLED;
  const previousMask = process.umask(0o077);
  try {
    await new Promise((success, failure) => {
      const child = launch(
        "gh",
        [
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--git-protocol",
          "https",
          "--web",
        ],
        { cwd: ctx.config.workspace, env, stdio: "inherit", shell: false },
      );
      child.once("error", () =>
        failure(
          new Error(
            "GitHub CLI could not start. Install gh as described in docs/integrations.md.",
          ),
        ),
      );
      child.once("exit", (code) =>
        code === 0
          ? success()
          : failure(
              new Error(
                "GitHub login was not completed. No token was captured by the configurator.",
              ),
            ),
      );
    });
  } finally {
    process.umask(previousMask);
  }
}

export async function integrationStatus(ctx, entry, execute = command) {
  if (entry.id === "github") {
    try {
      await execute("gh", ["--version"], {
        env: ctx.env,
        cwd: ctx.config.workspace,
      });
      await execute("gh", ["auth", "status", "--hostname", "github.com"], {
        env: ctx.env,
        cwd: ctx.config.workspace,
      });
      return {
        id: entry.id,
        provider: ctx.provider,
        status: "authenticated",
        detail:
          "GitHub CLI authentication check passed; repository permissions and writes were not tested.",
      };
    } catch {
      return {
        id: entry.id,
        provider: ctx.provider,
        status: "not_ready",
        detail:
          "Install gh or complete the dedicated GitHub login. No account diagnostics were printed.",
      };
    }
  }
  const result = await inspectMcp({
    ...ctx,
    name: entry.name,
    server: entry.server,
    toolApproval: entry.toolApproval,
    execute,
  });
  return {
    id: entry.id,
    provider: ctx.provider,
    name: entry.name,
    status: result.status,
    detail:
      "Configuration inspection only; server reachability, tools, login and remote entitlement were not tested.",
  };
}

async function executable(path) {
  if (!path || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))
    throw new Error("Provide an absolute executable path.");
  if (!(await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink())
    throw new Error("Executable path is not a file.");
  await access(path, constants.X_OK);
  return path;
}

async function serverFor(ctx, id, options, ask) {
  const item = catalog.find((c) => c.id === id);
  if (!item) throw new Error("Unknown integration. Run integrations list.");
  if (id === "playwright")
    return {
      ...(await preparePlaywright({
        config: ctx.config,
        publicRoot: ctx.publicRoot,
        browserBin: options["browser-bin"],
      })),
      ...(options["tool-approval"] === undefined
        ? {}
        : { toolApproval: options["tool-approval"] }),
    };
  if (Object.hasOwn(remoteServices, id)) {
    const modes = remoteServices[id].authModes;
    let auth =
      options.auth ?? (options["credential-file"] ? "api-key" : undefined);
    if (!auth && ask) {
      const selected = await ask(
        `Authentication (${modes.join(" / ")}; Enter uses oauth): `,
      );
      auth = selected || "oauth";
    }
    auth ??= "oauth";
    const credentialFile =
      options["credential-file"] ??
      (auth === "api-key" && ask
        ? await ask(
            "Absolute private credential file path (never paste a token): ",
          )
        : undefined);
    return buildServiceEntry(ctx, id, { auth, credentialFile });
  }
  if (item.server) return { name: item.nameInConfig, server: item.server };
  if (id === "custom") {
    const input =
      options.spec ??
      (ask && (await ask("Absolute private MCP specification JSON path: ")));
    const file = await privatePath(input, ctx.publicRoot, [
      ctx.config.workspace,
    ]);
    const spec = await readPrivateJson(file);
    if (
      !spec ||
      !/^szpont_[a-z0-9_]{1,48}$/.test(spec.name) ||
      !spec.server ||
      Object.keys(spec).some((k) => !["name", "server"].includes(k)) ||
      Object.keys(spec.server).some(
        (k) => !["url", "command", "args"].includes(k),
      )
    )
      throw new Error(
        "Custom spec requires a szpont_ name and a server with only url or command/args. Keep credentials out of the specification.",
      );
    return spec;
  }
  if (id === "camoufox") {
    if (
      await access("/.dockerenv").then(
        () => true,
        () => false,
      )
    )
      throw new Error(
        "Camoufox requires a provisioned Linux host, Python environment, browser binary and display. It is not bundled in the engine container; see packages/browser/README.md.",
      );
    const python = await executable(
      options.python ??
        (ask && (await ask("Absolute provisioned browser Python path: "))),
    );
    const browser = await executable(
      options["browser-bin"] ??
        (ask && (await ask("Absolute verified camoufox-bin path: "))),
    );
    const display =
      options.display ??
      ctx.env.DISPLAY ??
      (ask && (await ask("Local X display (for example :99): ")));
    if (!/^:[0-9]{1,4}(?:\.[0-9])?$/.test(display ?? ""))
      throw new Error(
        "Camoufox needs a local DISPLAY such as :99. Provision Xvfb first.",
      );
    await command(python, ["-c", "import szpont_browser, camoufox, mcp"], {
      env: ctx.env,
      cwd: ctx.config.workspace,
    }).catch(() => {
      throw new Error(
        "Install the hash-locked browser package in this Python environment first; see packages/browser/README.md.",
      );
    });
    const profile = await privatePath(ctx.config.browserDir, ctx.publicRoot, [
      ctx.config.workspace,
    ]);
    const artifacts = await privatePath(
      join(ctx.config.artifactsDir, "browser"),
      ctx.publicRoot,
      [ctx.config.workspace],
    );
    await privateDirectory(profile);
    await privateDirectory(artifacts);
    return {
      name: "szpont_browser",
      server: {
        command: python,
        args: ["-m", "szpont_browser"],
        env: {
          CAMOUFOX_EXECUTABLE_PATH: browser,
          SZPONT_BROWSER_PROFILE: profile,
          SZPONT_BROWSER_ARTIFACTS: artifacts,
          DISPLAY: display,
          ...(ctx.env.XAUTHORITY ? { XAUTHORITY: ctx.env.XAUTHORITY } : {}),
        },
      },
    };
  }
  throw new Error("This integration does not use MCP.");
}

export async function runIntegrations(
  args,
  {
    env = process.env,
    publicRoot = root,
    input = process.stdin,
    output = process.stdout,
  } = {},
) {
  const options = {},
    positional = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (["--yes", "--json", "--login", "--help"].includes(value))
      options[value.slice(2)] = true;
    else if (
      [
        "--runner",
        "--python",
        "--browser-bin",
        "--display",
        "--spec",
        "--auth",
        "--credential-file",
        "--tool-approval",
      ].includes(value)
    ) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${value}.`);
      options[value.slice(2)] = args[++i];
    } else if (value.startsWith("-"))
      throw new Error("Unknown option. Use --help.");
    else positional.push(value);
  }
  const print = (value) => output.write(value + "\n");
  if (options.help) {
    print(help);
    return;
  }
  if (options.runner !== undefined && !providers.includes(options.runner))
    throw new Error(
      "Unsupported runner. Choose codex, claude or opencode; another CLI needs an engine adapter.",
    );
  let selectedRunner = options.runner ?? env.SZPONT_RUNNER ?? "codex";
  let [action, id, extra] = positional;
  if (
    extra ||
    (action && !["list", "add", "status", "login", "remove"].includes(action))
  )
    throw new Error(help);
  if (options.json && action !== "list" && action !== "status")
    throw new Error("--json is supported for list and status only.");
  if (action === "list") {
    print(
      options.json
        ? JSON.stringify(catalog, null, 2)
        : catalog.map((c) => `${c.id.padEnd(14)} ${c.description}`).join("\n"),
    );
    return;
  }
  let terminal;
  const ask =
    input.isTTY && output.isTTY
      ? async (question) => {
          terminal ??= createInterface({ input, output });
          return (await terminal.question(question)).trim();
        }
      : undefined;
  try {
    if (!action) {
      if (!ask)
        throw new Error(
          "Interactive setup needs a TTY. Use list, or add <id> --yes with explicit options.",
        );
      print(
        "Szpont integrations — connect tools to your own runner and accounts.\n",
      );
      if (!options.runner) {
        print(
          providers
            .map(
              (provider, n) =>
                `${n + 1}. ${runnerNames[provider]}${provider === selectedRunner ? " (current default)" : ""}`,
            )
            .join("\n") + "\n0. Exit",
        );
        const choice = await ask(
          "Choose a runner (Enter keeps the current default): ",
        );
        if (choice === "0") return;
        if (choice) {
          selectedRunner = providers[Number(choice) - 1];
          if (!selectedRunner)
            throw new Error("Choose one of the listed runners.");
        }
      }
      print(
        catalog
          .map((c, n) => `${n + 1}. ${c.name} — ${c.description}`)
          .join("\n") + "\n0. Exit",
      );
      const choice = await ask("Choose an integration: ");
      if (choice === "0") return;
      id = catalog[Number(choice) - 1]?.id;
      if (!id) throw new Error("Choose one of the listed numbers.");
      action = "add";
    }
    if (id && !catalog.some((c) => c.id === id))
      throw new Error("Unknown integration. Use list.");
    if (
      options["tool-approval"] !== undefined &&
      (action !== "add" ||
        id !== "playwright" ||
        selectedRunner !== "codex" ||
        !["approve", "prompt"].includes(options["tool-approval"]))
    )
      throw new Error(
        "--tool-approval approve|prompt applies only to add playwright --runner codex; other integrations and runners keep their own approval policy.",
      );
    if (
      (options.auth !== undefined ||
        options["credential-file"] !== undefined) &&
      (action !== "add" || !Object.hasOwn(remoteServices, id ?? ""))
    )
      throw new Error(
        "Authentication options apply only to add perplexity, firecrawl, tinyfish or posthog.",
      );
    if (["add", "remove", "login"].includes(action) && !id)
      throw new Error("Choose an integration ID. Use list.");
    if (
      env.SZPONT_CONTAINER_RUNNER &&
      selectedRunner !== env.SZPONT_CONTAINER_RUNNER
    )
      throw new Error(
        "This container packages Codex only. Configure Claude Code or OpenCode on the documented Linux host deployment; their CLI binaries and isolation are required.",
      );
    const ctx = await createContext(
      { ...env, SZPONT_RUNNER: selectedRunner },
      publicRoot,
    );
    if (action === "status") {
      const value = await registry(ctx);
      const entries = value.integrations.filter(
        (e) => e.provider === ctx.provider && (!id || e.id === id),
      );
      const results = [];
      for (const e of entries) results.push(await integrationStatus(ctx, e));
      print(
        options.json
          ? JSON.stringify(
              { provider: ctx.provider, integrations: results },
              null,
              2,
            )
          : results.length
            ? results
                .map((r) => `${r.id}: ${r.status} — ${r.detail}`)
                .join("\n")
            : "No managed integrations for this runner. Use add <id>.",
      );
      return;
    }
    if (action === "login" && id !== "github")
      throw new Error(
        "Only GitHub login is started here. Use your runner's MCP OAuth login for remote servers.",
      );
    print(
      `Runner: ${ctx.provider}. ${action === "login" ? "GitHub's own terminal login will open." : "Only the selected integration and managed instructions will change."}`,
    );
    if (selectedRunner !== (env.SZPONT_RUNNER ?? "codex"))
      print(
        `Configuring ${runnerNames[selectedRunner]} tools only. For new Discord threads, set SZPONT_RUNNER=${selectedRunner} in the service environment separately; existing threads keep their runner.`,
      );
    if (action === "add" && id === "custom")
      print(
        "A local MCP server executes with service-account permissions. Use a reviewed executable and non-secret arguments.",
      );
    if (
      !options.yes &&
      (!ask || !/^y(?:es)?$/i.test(await ask("Continue? [y/N] ")))
    )
      throw new Error(
        "No changes made. Use --yes for explicit noninteractive setup.",
      );
    await withLock(ctx, async () => {
      if (action === "login") {
        if (!ask)
          throw new Error(
            "GitHub web login requires a TTY; no authentication was attempted.",
          );
        terminal?.close();
        terminal = undefined;
        await loginGitHub(ctx);
        print(
          "GitHub login finished. Run status github to inspect authentication.",
        );
        return;
      }
      const value = await registry(ctx);
      await checkInstructionDestination(ctx);
      if (action === "add") {
        let entry = { id, provider: ctx.provider, name: "github" };
        if (id === "github") {
          await privateDirectory(ctx.config.githubConfigDir);
          await command("gh", ["--version"], {
            env: ctx.env,
            cwd: ctx.config.workspace,
          }).catch(() => {
            throw new Error(
              "Install GitHub CLI (gh) first. See docs/integrations.md; the new Docker build includes it.",
            );
          });
        } else {
          entry = { ...entry, ...(await serverFor(ctx, id, options, ask)) };
        }
        const conflict = value.integrations.find(
          (e) =>
            e.provider === ctx.provider && e.name === entry.name && e.id !== id,
        );
        if (conflict)
          throw new Error(
            "This managed MCP name is already assigned to another integration.",
          );
        const next = value.integrations.filter(
          (e) => !(e.provider === ctx.provider && e.name === entry.name),
        );
        next.push(entry);
        if (
          next.length > 30 ||
          Buffer.byteLength(JSON.stringify({ ...value, integrations: next })) >
            65_000 ||
          Buffer.byteLength(playbook(next)) > 32_000
        )
          throw new Error(
            "Integration configuration exceeds its bounded file or entry limit; nothing was registered.",
          );
        if (id !== "github") {
          if (ctx.provider === "codex")
            await privateDirectory(ctx.config.codexHome);
          await registerMcp({
            ...ctx,
            name: entry.name,
            server: entry.server,
            toolApproval: entry.toolApproval,
          });
        }
        value.integrations = next;
        await saveRegistry(ctx, value);
        print(
          "Configured. Managed tool-use instructions will be read on the next task.",
        );
        if (id === "github") {
          print(
            "Run `npm run integrations -- login github` to sign in using GitHub's own flow. HTTPS Git operations can use `git -c 'credential.helper=!gh auth git-credential' ...` without changing global Git configuration.",
          );
          if (options.login) {
            if (!ask)
              throw new Error(
                "Configuration saved; --login requires a TTY. Run login github separately.",
              );
            terminal?.close();
            terminal = undefined;
            await loginGitHub(ctx);
          }
        } else
          print(
            "MCP configuration was registered; a live tool call, login and account access have not been tested.",
          );
        if (entry.toolApproval !== undefined)
          print(
            entry.toolApproval === "approve"
              ? "Explicit Codex approval applies only to this built-in Playwright server. Browser tools can perform real website actions; task authorization and managed security controls still apply."
              : "This Codex Playwright server explicitly prompts for tool approval; unattended runs cannot answer those prompts.",
          );
      } else if (action === "remove") {
        const entries = value.integrations.filter(
          (e) => e.provider === ctx.provider && e.id === id,
        );
        if (!entries.length)
          throw new Error("No managed integration matches this runner and ID.");
        for (const entry of entries)
          if (id !== "github")
            await unregisterMcp({
              ...ctx,
              name: entry.name,
              server: entry.server,
              toolApproval: entry.toolApproval,
            });
        value.integrations = value.integrations.filter(
          (e) => !entries.includes(e),
        );
        await saveRegistry(ctx, value);
        print(
          id === "github"
            ? "GitHub guidance removed. Credentials and CLI access remain; use gh auth logout in the dedicated GH_CONFIG_DIR to disconnect and revoke account access separately if needed."
            : "Managed MCP configuration removed. Remote grants, account data and browser profiles were preserved.",
        );
      }
    });
  } finally {
    terminal?.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await runIntegrations(process.argv.slice(2)).catch((error) => {
    // Only our controlled errors are surfaced. Never echo subprocess output or credentials.
    const message =
      error instanceof Error &&
      error.message &&
      !error.stdout &&
      !error.stderr &&
      !error.code
        ? error.message
        : "Integration setup failed. Check the private paths, prerequisites and selected runner; no subprocess diagnostics were printed.";
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  });
}
