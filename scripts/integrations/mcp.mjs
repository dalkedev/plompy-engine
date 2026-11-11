import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isManagedReadonlyUrl } from "../../packages/mcp-bridge/src/services.mjs";

const defaultExecute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const requireApp = createRequire(
  new URL("../../apps/discord-agent/package.json", import.meta.url),
);
const playwrightLauncher = fileURLToPath(
  new URL("../../packages/playwright/launch.mjs", import.meta.url),
);
const pathVariables = new Set([
  "PLOMPY_BROWSER_PROFILE",
  "SZPONT_BROWSER_PROFILE",
  "SZPONT_BROWSER_ARTIFACTS",
  "PLOMPY_BROWSER_ARTIFACTS",
  "CAMOUFOX_EXECUTABLE_PATH",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
]);
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const within = (parent, child) => {
  const part = relative(parent, child);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
  );
};
const result = (provider, name, status, changed = false) => ({
  provider,
  name,
  status,
  changed,
});

async function canonicalDestination(input) {
  const missing = [];
  let ancestor = resolve(input);
  for (;;) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Cannot inspect the private MCP path.");
      const parent = dirname(ancestor);
      if (parent === ancestor)
        throw new Error("Cannot resolve the private MCP path.");
      missing.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

async function privatePath(path, config) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) === sep ||
    /[\x00-\x1f\x7f]/.test(path)
  )
    throw new Error("MCP configuration requires an absolute private path.");
  const target = await canonicalDestination(path);
  for (const root of [sourceRoot, config.publicRoot].filter(Boolean)) {
    const canonicalRoot = await canonicalDestination(root);
    if (within(canonicalRoot, target) || within(target, canonicalRoot))
      throw new Error(
        "Keep MCP configuration and browser state outside the public source tree.",
      );
  }
  return target;
}

async function existing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot inspect the private MCP configuration.");
  }
}

function assertOwnedPrivate(metadata, directory = false) {
  if (
    metadata.isSymbolicLink() ||
    (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o077) !== 0 ||
    (!directory && metadata.nlink !== 1)
  )
    throw new Error(
      "MCP configuration must be owned by the service user, use private permissions, and contain no symlink or hardlink.",
    );
}

async function prepareParent(path, config, create) {
  // Canonical aliases into public source are rejected before any mkdir/write.
  await privatePath(path, config);
  const parent = dirname(path);
  if (create) {
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    } catch {
      throw new Error("Cannot create the private MCP configuration directory.");
    }
  }
  const metadata = await existing(parent);
  if (metadata) assertOwnedPrivate(metadata, true);
  else if (create)
    throw new Error(
      "Create the private MCP configuration directory as the service user.",
    );
  return Boolean(metadata);
}

async function normalizedServer(server, config) {
  if (!plain(server))
    throw new Error("Provide a local MCP command or a remote HTTPS URL.");
  if (Object.hasOwn(server, "url")) {
    if (Object.keys(server).some((key) => key !== "url"))
      throw new Error(
        "Remote MCP definitions accept only a URL; keep credentials out of setup arguments.",
      );
    let url;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error("Remote MCP requires an HTTPS URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.search && !isManagedReadonlyUrl(server.url)) ||
      url.hash
    )
      throw new Error(
        "Remote MCP requires HTTPS without credentials, query parameters, or fragments.",
      );
    return { url: url.href };
  }
  if (
    Object.keys(server).some(
      (key) => !["command", "args", "env"].includes(key),
    ) ||
    typeof server.command !== "string" ||
    !server.command ||
    server.command.startsWith("-") ||
    /[\x00-\x1f\x7f]/.test(server.command) ||
    !Array.isArray(server.args) ||
    server.args.some(
      (value) => typeof value !== "string" || /[\x00\r\n]/.test(value),
    )
  )
    throw new Error(
      "Local MCP requires a command and an argument array; shell strings are not supported.",
    );
  const variables = server.env ?? {};
  if (!plain(variables)) throw new Error("Invalid MCP environment definition.");
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value !== "string")
      throw new Error(
        "MCP environment values must be nonsecret paths or a local display.",
      );
    if (key === "DISPLAY") {
      if (!/^:\d+(?:\.\d+)?$/.test(value))
        throw new Error("Use a local X11 display such as :99.");
    } else if (pathVariables.has(key)) await privatePath(value, config);
    else
      throw new Error(
        "MCP setup accepts only nonsecret browser path variables and DISPLAY; never supply credential variables.",
      );
  }
  return {
    command: server.command,
    args: [...server.args],
    ...(Object.keys(variables).length ? { env: { ...variables } } : {}),
  };
}

async function sameBuiltinPath(candidate, expected, allowLegacyAlias) {
  if (candidate === expected) return true;
  if (!allowLegacyAlias || typeof candidate !== "string" || !isAbsolute(candidate)) return false;
  try { return await realpath(candidate) === await realpath(expected); }
  catch { return false; }
}

async function input(options, inspectLegacy = false) {
  const { provider, name } = options;
  const config = {
    ...options.config,
    ...(options.publicRoot ? { publicRoot: options.publicRoot } : {}),
  };
  if (!["codex", "claude", "opencode"].includes(provider))
    throw new Error(
      "Select a supported MCP provider: codex, claude, or opencode.",
    );
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  )
    throw new Error(
      "Use a safe MCP server name of 1-64 letters, digits, underscores, or hyphens.",
    );
  const server = await normalizedServer(options.server, config);
  if (options.toolApproval !== undefined) {
    const allowLegacyAlias = inspectLegacy && name === "szpont_playwright";
    if (
      !["approve", "prompt"].includes(options.toolApproval) ||
      provider !== "codex" ||
      !["plompy_playwright", "szpont_playwright"].includes(name) ||
      server.url ||
      !(await sameBuiltinPath(server.command, process.execPath, allowLegacyAlias)) ||
      server.env ||
      ![5, 7].includes(server.args.length) ||
      !(await sameBuiltinPath(server.args[0], playwrightLauncher, allowLegacyAlias)) ||
      server.args[1] !== "--output-dir" ||
      server.args[3] !== "--browser-cache" ||
      (server.args.length === 7 &&
        (server.args[5] !== "--browser-bin" ||
          !isAbsolute(server.args[6]) ||
          /[\x00-\x1f\x7f]/.test(server.args[6])))
    )
      throw new Error(
        "Tool approval is an explicit Codex-only option for the built-in Playwright launcher; arbitrary MCP servers and other runners are not supported.",
      );
    for (const path of [server.args[2], server.args[4]])
      await privatePath(path, config);
  }
  return {
    ...options,
    config,
    server,
  };
}

async function safely(operation) {
  try {
    return await operation();
  } catch (error) {
    // Native filesystem errors include private paths. Configuration diagnostics
    // intentionally never echo file contents, subprocess output, or secret state.
    if (error?.code)
      throw new Error(
        "Private MCP configuration could not be read or updated; inspect ownership, permissions, and concurrent edits locally.",
      );
    throw error;
  }
}

function expected(provider, server) {
  if (provider === "claude")
    return server.url
      ? { type: "http", url: server.url }
      : { type: "stdio", ...server };
  if (provider === "opencode")
    return server.url
      ? { type: "remote", url: server.url, enabled: true }
      : {
          type: "local",
          command: [server.command, ...server.args],
          enabled: true,
          ...(server.env ? { environment: server.env } : {}),
        };
}

function codexMatches(entry, server, toolApproval) {
  if (!plain(entry) || entry.enabled !== true || !plain(entry.transport))
    return false;
  // Non-default restrictions, headers, injected variables, working directory, or
  // future unknown settings make this a different entry. Do not replace/remove it.
  if (
    Object.entries(entry).some(
      ([key, value]) =>
        !["name", "enabled", "transport"].includes(key) &&
        value !== null &&
        !(key === "default_tools_approval_mode" && value === toolApproval),
    )
  )
    return false;
  const transport = entry.transport;
  const required = server.url
    ? { type: "streamable_http", url: server.url }
    : { type: "stdio", command: server.command, args: server.args };
  if (
    Object.entries(required).some(
      ([key, value]) => !isDeepStrictEqual(transport[key], value),
    )
  )
    return false;
  const environment = transport.env ?? {};
  if (!server.url && !isDeepStrictEqual(environment, server.env ?? {}))
    return false;
  return !Object.entries(transport).some(
    ([key, value]) =>
      !Object.hasOwn(required, key) &&
      !(key === "env" && !server.url) &&
      value !== null &&
      !(key === "env_vars" && Array.isArray(value) && value.length === 0),
  );
}

async function codexCommand(options, args, program = "mcp") {
  const { config, execute = defaultExecute, env = process.env } = options;
  const home = config.codexHome;
  await privatePath(home, config);
  const metadata = await existing(home);
  if (!metadata)
    throw new Error(
      "Create CODEX_HOME with mode 700 as the service user before configuring MCP.",
    );
  assertOwnedPrivate(metadata, true);
  const file = await existing(join(home, "config.toml"));
  if (file) assertOwnedPrivate(file);
  const childEnv = Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SystemRoot"]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  childEnv.CODEX_HOME = home;
  try {
    return await execute(config.codexBin ?? "codex", [program, ...args], {
      env: childEnv,
      cwd: home,
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (
      program === "mcp" &&
      args[0] === "get" &&
      error.code === 1 &&
      /^Error: No MCP server named '[a-zA-Z0-9_-]+' found\.\s*$/.test(
        error.stderr ?? "",
      )
    )
      return { stdout: "", missing: true };
    throw new Error(
      "Codex MCP command failed; check the configured CLI, CODEX_HOME, permissions, and configuration locally. Command output was withheld.",
    );
  }
}

async function inspectCodex(options) {
  const reply = await codexCommand(options, ["get", options.name, "--json"]);
  const raw = await readCodexTable(options);
  if (reply.missing)
    return result(
      options.provider,
      options.name,
      raw === undefined ? "missing" : "conflict",
    );
  let entry;
  try {
    entry = JSON.parse(reply.stdout);
  } catch {
    throw new Error(
      "Codex returned invalid MCP configuration JSON; no changes were made.",
    );
  }
  return result(
    options.provider,
    options.name,
    entry.name === options.name &&
      codexMatches(entry, options.server, options.toolApproval) &&
      rawCodexMatches(raw, options.server, options.toolApproval)
      ? "configured"
      : "conflict",
  );
}

async function withCodexLock(options, operation) {
  const home = options.config.codexHome;
  await privatePath(home, options.config);
  const metadata = await existing(home);
  if (!metadata)
    throw new Error(
      "Create CODEX_HOME with mode 700 as the service user before configuring MCP.",
    );
  assertOwnedPrivate(metadata, true);
  const lock = join(home, ".szpont-mcp.lock");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "MCP configuration is locked; finish the other setup process or inspect its stale lock locally.",
    );
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

async function readCodexBytes(path) {
  const metadata = await existing(path);
  if (!metadata) return null;
  assertOwnedPrivate(metadata);
  if (metadata.size > 1024 * 1024)
    throw new Error("Private Codex configuration exceeds the 1 MiB limit.");
  return readFile(path, "utf8");
}

async function readCodexTable(options) {
  const bytes = await readCodexBytes(
    join(options.config.codexHome, "config.toml"),
  );
  if (bytes === null) return undefined;
  let data;
  try {
    data = requireApp("smol-toml").parse(bytes);
  } catch {
    throw new Error(
      "Private Codex TOML could not be parsed; install the locked engine dependencies and inspect configuration locally. Existing files were preserved.",
    );
  }
  if (data.mcp_servers === undefined) return undefined;
  if (!plain(data.mcp_servers))
    throw new Error(
      "Codex MCP configuration must contain a server table; existing files were preserved.",
    );
  return Object.hasOwn(data.mcp_servers, options.name)
    ? data.mcp_servers[options.name]
    : undefined;
}

function rawCodexMatches(raw, server, toolApproval) {
  if (!plain(raw)) return false;
  const actual = { ...raw };
  if (actual.enabled === true) delete actual.enabled;
  if (plain(actual.env)) actual.env = { ...actual.env };
  if (
    !server.url &&
    plain(actual.env) &&
    Object.keys(actual.env).length === 0 &&
    !server.env
  )
    delete actual.env;
  // `mcp get --json` omits approval overrides, tools and some other policy.
  // The parsed table, rather than its CLI projection, is the ownership guard.
  return isDeepStrictEqual(actual, {
    ...server,
    ...(toolApproval === undefined
      ? {}
      : { default_tools_approval_mode: toolApproval }),
  });
}

async function registerCodexTable(options) {
  // `codex mcp add --url` performs OAuth discovery and may open an interactive
  // login immediately. This configuration-only wizard instead appends a single
  // quoted table, validates it with `mcp get` in an isolated private home, then
  // atomically installs the exact validated bytes. It never starts OAuth.
  const home = options.config.codexHome;
  const path = join(home, "config.toml");
  const before = await readCodexBytes(path);
  const fields = options.server.url
    ? `url = ${JSON.stringify(options.server.url)}\n`
    : `command = ${JSON.stringify(options.server.command)}\nargs = ${JSON.stringify(options.server.args)}\n`;
  const approval =
    options.toolApproval === undefined
      ? ""
      : `default_tools_approval_mode = ${JSON.stringify(options.toolApproval)}\n`;
  const after = `${before ?? ""}\n[mcp_servers.${JSON.stringify(options.name)}]\n${fields}${approval}`;
  const staging = await mkdtemp(join(home, ".plompy-mcp-check-"));
  const temporary = join(home, `.plompy-mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(join(staging, "config.toml"), after, {
      mode: 0o600,
      flag: "wx",
    });
    if (options.toolApproval !== undefined) {
      // Fail closed on CLIs which silently ignore newer TOML options. This only
      // parses startup configuration: it does not start MCP, login or a model.
      await codexCommand(
        { ...options, config: { ...options.config, codexHome: staging } },
        ["--strict-config", "--print-startup-config"],
        "app-server",
      );
    }
    const staged = await inspectCodex({
      ...options,
      config: { ...options.config, codexHome: staging },
    });
    if (staged.status !== "configured")
      throw new Error(
        "Codex did not accept the candidate MCP table; existing configuration was preserved.",
      );
    const pending = await open(temporary, "wx", 0o600);
    try {
      await pending.writeFile(after);
      await pending.sync();
    } finally {
      await pending.close();
    }
    if ((await readCodexBytes(path)) !== before)
      throw new Error(
        "Codex configuration changed during setup; existing bytes were preserved. Retry after the other editor finishes.",
      );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

function jsonPath(options) {
  const key =
    options.provider === "claude" ? "claudeMcpConfig" : "opencodeConfig";
  const setting =
    options.provider === "claude"
      ? "PLOMPY_CLAUDE_MCP_CONFIG"
      : "PLOMPY_OPENCODE_CONFIG";
  if (!options.config[key])
    throw new Error(
      `Set ${setting} to an explicit absolute private JSON file before configuring MCP.`,
    );
  if (!options.config[key].endsWith(".json"))
    throw new Error(
      `${setting} must name a JSON file; JSONC files are not rewritten.`,
    );
  return options.config[key];
}

async function readJson(path, config) {
  await privatePath(path, config);
  const metadata = await existing(path);
  if (!metadata) return { data: {}, bytes: null, metadata: null };
  assertOwnedPrivate(metadata);
  if (metadata.size > 65_536)
    throw new Error("Private MCP configuration exceeds the 64 KiB limit.");
  const bytes = await readFile(path, "utf8");
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    throw new Error(
      "Private MCP configuration is not valid JSON; existing bytes were preserved.",
    );
  }
  if (!plain(data))
    throw new Error(
      "Private MCP configuration must be a JSON object; existing bytes were preserved.",
    );
  return { data, bytes, metadata };
}

function jsonStatus(options, document) {
  const key = options.provider === "claude" ? "mcpServers" : "mcp";
  const servers = document.data[key];
  if (servers !== undefined && !plain(servers))
    throw new Error(
      "The existing MCP server collection must be a JSON object; no changes were made.",
    );
  if (!servers || !Object.hasOwn(servers, options.name))
    return result(options.provider, options.name, "missing");
  return result(
    options.provider,
    options.name,
    isDeepStrictEqual(
      servers[options.name],
      expected(options.provider, options.server),
    )
      ? "configured"
      : "conflict",
  );
}

async function inspectJson(options) {
  const path = jsonPath(options);
  await prepareParent(path, options.config, false);
  return jsonStatus(options, await readJson(path, options.config));
}

async function mutateJson(options, remove) {
  const path = jsonPath(options);
  await prepareParent(path, options.config, true);
  const lock = `${path}.szpont-integration.lock`;
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "MCP configuration is locked; finish the other setup process or inspect its stale lock locally.",
    );
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const document = await readJson(path, options.config);
    const current = jsonStatus(options, document);
    if (current.status === "conflict")
      throw new Error(
        "An existing MCP entry differs; it was preserved. Choose another name or inspect it locally.",
      );
    if (
      (remove && current.status === "missing") ||
      (!remove && current.status === "configured")
    )
      return current;
    const key = options.provider === "claude" ? "mcpServers" : "mcp";
    const servers = { ...(document.data[key] ?? {}) };
    if (remove) delete servers[options.name];
    else servers[options.name] = expected(options.provider, options.server);
    const updated =
      JSON.stringify({ ...document.data, [key]: servers }, null, 2) + "\n";
    if (Buffer.byteLength(updated) > 65_536)
      throw new Error(
        "Private MCP configuration exceeds the 64 KiB limit; existing bytes were preserved.",
      );
    const pending = await open(temporary, "wx", 0o600);
    try {
      await pending.writeFile(updated);
      await pending.sync();
    } finally {
      await pending.close();
    }
    const latest = await readJson(path, options.config);
    if (
      latest.bytes !== document.bytes ||
      latest.metadata?.ino !== document.metadata?.ino
    )
      throw new Error(
        "MCP configuration changed during setup; existing bytes were preserved. Retry after the other editor finishes.",
      );
    await rename(temporary, path);
    return result(
      options.provider,
      options.name,
      remove ? "removed" : "configured",
      true,
    );
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
    await rm(lock, { force: true });
  }
}

/** Configuration-only checks: these functions never claim that MCP connected. */
export async function inspectMcp(options) {
  return safely(async () => {
    const request = await input(options, true);
    return request.provider === "codex"
      ? inspectCodex(request)
      : inspectJson(request);
  });
}

export async function registerMcp(options) {
  return safely(async () => {
    const request = await input(options);
    if (request.provider !== "codex") return mutateJson(request, false);
    return withCodexLock(request, async () => {
      const current = await inspectCodex(request);
      if (current.status === "configured") return current;
      if (current.status === "conflict")
        throw new Error(
          "An existing MCP entry differs; it was preserved. Choose another name or inspect it locally.",
        );
      if (request.server.url || request.toolApproval !== undefined)
        await registerCodexTable(request);
      else {
        const args = ["add", request.name];
        for (const [key, value] of Object.entries(request.server.env ?? {}))
          args.push("--env", `${key}=${value}`);
        args.push("--", request.server.command, ...request.server.args);
        await codexCommand(request, args);
      }
      const checked = await inspectCodex(request);
      if (checked.status !== "configured")
        throw new Error(
          "Codex did not retain the expected MCP entry; inspect its private configuration locally.",
        );
      return { ...checked, changed: true };
    });
  });
}

export async function unregisterMcp(options) {
  return safely(async () => {
    const request = await input(options, true);
    if (request.provider !== "codex") return mutateJson(request, true);
    return withCodexLock(request, async () => {
      const current = await inspectCodex(request);
      if (current.status === "missing") return current;
      if (current.status === "conflict")
        throw new Error(
          "The MCP entry no longer matches this integration; it was preserved.",
        );
      await codexCommand(request, ["remove", request.name]);
      const checked = await inspectCodex(request);
      if (checked.status !== "missing")
        throw new Error(
          "Codex did not remove the expected MCP entry; inspect its private configuration locally.",
        );
      return result(request.provider, request.name, "removed", true);
    });
  });
}
