import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
export const SNOWFLAKE = /^\d{17,20}$/;
export const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_MESSAGE = 8000;
export const MAX_OUTPUT = 32_000;
export const PROVIDERS = ["codex", "claude", "opencode"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export function isSessionId(value: string, provider: ProviderId): boolean {
  return provider === "opencode"
    ? /^ses_[A-Za-z0-9]{26}$/.test(value)
    : SESSION_ID.test(value);
}
export interface Config {
  token: string;
  guildId: string;
  ownerId: string;
  botId: string;
  parentId: string;
  workspace: string;
  stateDir: string;
  artifactsDir: string;
  codexHome: string;
  browserDir: string;
  codexBin: string;
  timeoutMs: number;
  githubConfigDir?: string;
  provider?: ProviderId;
  claudeBin?: string;
  claudeHome?: string;
  claudeModel?: string;
  claudeEffort?: string;
  claudeMcpConfig?: string;
  opencodeBin?: string;
  opencodeHome?: string;
  opencodeModel?: string;
  opencodeConfig?: string;
  opencodeAllowHostExecution?: boolean;
}
export function runnerHome(
  config: Config,
  provider: ProviderId = config.provider ?? "codex",
): string {
  return provider === "codex"
    ? config.codexHome
    : provider === "claude"
      ? (config.claudeHome ?? resolve(config.stateDir, "..", "claude"))
      : (config.opencodeHome ?? resolve(config.stateDir, "..", "opencode"));
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const directory = (key: string): string => {
    const value = required(key);
    if (!isAbsolute(value)) throw new Error(`Absolute path required: ${key}`);
    return resolve(value);
  };
  const identity = (key: string): string => {
    const value = required(key);
    if (!SNOWFLAKE.test(value))
      throw new Error(`Invalid Discord identity: ${key}`);
    return value;
  };
  const guildId = identity("SZPONT_DISCORD_GUILD_ID");
  const ownerId = identity("SZPONT_DISCORD_OWNER_ID");
  const botId = identity("SZPONT_DISCORD_BOT_ID");
  const parentId = required("SZPONT_DISCORD_PARENT_CHANNEL_ID");
  if (!SNOWFLAKE.test(parentId))
    throw new Error("Invalid private parent channel ID");
  const setting = (key: string): string | undefined => {
    const value = env[key];
    if (
      value !== undefined &&
      (!value.trim() ||
        value.length > 512 ||
        /[\x00-\x1f\x7f]/.test(value) ||
        value.startsWith("-"))
    )
      throw new Error(`Invalid runner setting: ${key}`);
    return value;
  };
  const provider = env.SZPONT_RUNNER ?? "codex";
  if (!PROVIDERS.includes(provider as ProviderId))
    throw new Error("Invalid SZPONT_RUNNER");
  const stateDir = directory("SZPONT_STATE_DIR");
  const privatePath = (
    key: string,
    selected: boolean,
    fallback: string,
  ): string =>
    selected || env[key] !== undefined
      ? directory(key)
      : resolve(stateDir, "..", fallback);
  const claudeModel = setting("SZPONT_CLAUDE_MODEL");
  const claudeEffort = setting("SZPONT_CLAUDE_EFFORT");
  if (
    claudeEffort &&
    !["low", "medium", "high", "xhigh", "max"].includes(claudeEffort)
  )
    throw new Error("Invalid SZPONT_CLAUDE_EFFORT");
  const opencodeModel = setting("SZPONT_OPENCODE_MODEL");
  if (opencodeModel && !/^[^/\s]+\/[^\s]+$/.test(opencodeModel))
    throw new Error("SZPONT_OPENCODE_MODEL must be provider/model");
  if (provider === "opencode" && !opencodeModel)
    throw new Error("Missing SZPONT_OPENCODE_MODEL");
  if (
    env.SZPONT_OPENCODE_HOST_EXECUTION !== undefined &&
    env.SZPONT_OPENCODE_HOST_EXECUTION !== "allow"
  )
    throw new Error("Invalid SZPONT_OPENCODE_HOST_EXECUTION");
  const timeoutMs = Number(env.SZPONT_TASK_TIMEOUT_MS ?? 1_200_000);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 3_600_000
  )
    throw new Error("Invalid task timeout");
  const workspace = directory("SZPONT_WORKSPACE");
  const githubConfigDir =
    env.GH_CONFIG_DIR === undefined
      ? resolve(stateDir, "..", "github")
      : directory("GH_CONFIG_DIR");
  if (
    dirname(githubConfigDir) === githubConfigDir ||
    /[\x00-\x1f\x7f]/.test(githubConfigDir)
  )
    throw new Error(
      "GH_CONFIG_DIR must be a private path outside the workspace",
    );
  const config: Config = {
    token: required("DISCORD_BOT_TOKEN"),
    guildId,
    ownerId,
    botId,
    parentId,
    workspace,
    stateDir,
    artifactsDir: directory("SZPONT_ARTIFACTS_DIR"),
    codexHome: privatePath("CODEX_HOME", provider === "codex", "codex"),
    browserDir: resolve(env.SZPONT_BROWSER_DIR ?? "/var/lib/szpont/browser"),
    codexBin: setting("SZPONT_CODEX_BIN") ?? "codex",
    timeoutMs,
    githubConfigDir,
    provider: provider as ProviderId,
    claudeBin: setting("SZPONT_CLAUDE_BIN") ?? "claude",
    claudeHome: privatePath(
      "CLAUDE_CONFIG_DIR",
      provider === "claude",
      "claude",
    ),
    ...(claudeModel ? { claudeModel } : {}),
    ...(claudeEffort ? { claudeEffort } : {}),
    ...(env.SZPONT_CLAUDE_MCP_CONFIG !== undefined
      ? { claudeMcpConfig: directory("SZPONT_CLAUDE_MCP_CONFIG") }
      : {}),
    opencodeBin: setting("SZPONT_OPENCODE_BIN") ?? "opencode",
    opencodeHome: privatePath(
      "SZPONT_OPENCODE_HOME",
      provider === "opencode",
      "opencode",
    ),
    ...(opencodeModel ? { opencodeModel } : {}),
    ...(env.SZPONT_OPENCODE_CONFIG !== undefined
      ? { opencodeConfig: directory("SZPONT_OPENCODE_CONFIG") }
      : {}),
    opencodeAllowHostExecution: env.SZPONT_OPENCODE_HOST_EXECUTION === "allow",
  };
  const overlaps = (left: string, right: string): boolean =>
    [relative(left, right), relative(right, left)].some(
      (part) =>
        part === "" ||
        (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)),
    );
  if (
    [
      workspace,
      stateDir,
      config.codexHome,
      config.claudeHome,
      config.opencodeHome,
    ].some((path) => path && overlaps(path, githubConfigDir))
  )
    throw new Error(
      "GH_CONFIG_DIR must be separate from the workspace, engine state and runner authentication directories",
    );
  return config;
}
export function childEnvironment(
  config: Config,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
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
    "CAMOUFOX_EXECUTABLE_PATH",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  const common = {
    ...result,
    SZPONT_WORKSPACE: config.workspace,
    SZPONT_ARTIFACTS_DIR: config.artifactsDir,
    SZPONT_BROWSER_DIR: config.browserDir,
    // Keep gh away from the service user's implicit ~/.config/gh credentials.
    // Only the integration setup command authenticates this dedicated directory.
    GH_CONFIG_DIR:
      config.githubConfigDir ?? resolve(config.stateDir, "..", "github"),
    NO_COLOR: "1",
    TERM: "dumb",
  };
  switch (config.provider ?? "codex") {
    case "codex":
      return { ...common, CODEX_HOME: config.codexHome };
    case "claude":
      return {
        ...common,
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CONFIG_DIR:
          config.claudeHome ?? resolve(config.stateDir, "..", "claude"),
      };
    case "opencode": {
      const home =
        config.opencodeHome ?? resolve(config.stateDir, "..", "opencode");
      return {
        ...common,
        HOME: home,
        XDG_CONFIG_HOME: resolve(home, "config"),
        XDG_DATA_HOME: resolve(home, "data"),
        XDG_STATE_HOME: resolve(home, "state"),
        XDG_CACHE_HOME: resolve(home, "cache"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_PURE: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      };
    }
  }
}
export function redact(value: string, token: string): string {
  const hidden = token ? value.replaceAll(token, "[redacted]") : value;
  return hidden
    .replace(
      /\b(?:sk-(?:proj-)?[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})\b/g,
      "[redacted]",
    )
    .replace(/\b[\w-]{23,28}\.[\w-]{6}\.[\w-]{25,}\b/g, "[redacted]");
}
export interface IncomingImage {
  id: string;
  url: string;
  contentType: string | null;
  size: number;
}
export interface Incoming {
  id: string;
  guildId: string | null;
  authorId: string;
  bot: boolean;
  webhook: boolean;
  channelId: string;
  parentId: string | null;
  thread: boolean;
  content: string;
  attachments: number;
  images?: IncomingImage[];
}
export function authorized(
  message: Incoming,
  config: Pick<Config, "guildId" | "ownerId" | "parentId">,
): boolean {
  return (
    message.guildId === config.guildId &&
    message.authorId === config.ownerId &&
    !message.bot &&
    !message.webhook &&
    SNOWFLAKE.test(message.id) &&
    SNOWFLAKE.test(message.channelId) &&
    message.thread &&
    message.parentId === config.parentId &&
    (message.content.trim().length > 0 || message.attachments > 0) &&
    message.content.length <= MAX_MESSAGE &&
    Buffer.byteLength(message.content, "utf8") <= 32_000 &&
    Number.isSafeInteger(message.attachments) &&
    message.attachments >= 0 &&
    (message.images === undefined
      ? message.attachments === 0
      : message.images.length === message.attachments)
  );
}
