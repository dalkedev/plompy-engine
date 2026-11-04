import { isAbsolute, resolve } from "node:path";
export const SNOWFLAKE = /^\d{17,20}$/;
export const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_MESSAGE = 8000;
export const MAX_OUTPUT = 32_000;
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
  const timeoutMs = Number(env.SZPONT_TASK_TIMEOUT_MS ?? 1_200_000);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 3_600_000
  )
    throw new Error("Invalid task timeout");
  return {
    token: required("DISCORD_BOT_TOKEN"),
    guildId,
    ownerId,
    botId,
    parentId,
    workspace: directory("SZPONT_WORKSPACE"),
    stateDir: directory("SZPONT_STATE_DIR"),
    artifactsDir: directory("SZPONT_ARTIFACTS_DIR"),
    codexHome: directory("CODEX_HOME"),
    browserDir: resolve(env.SZPONT_BROWSER_DIR ?? "/var/lib/szpont/browser"),
    codexBin: env.SZPONT_CODEX_BIN ?? "codex",
    timeoutMs,
  };
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
  return {
    ...result,
    CODEX_HOME: config.codexHome,
    SZPONT_WORKSPACE: config.workspace,
    SZPONT_ARTIFACTS_DIR: config.artifactsDir,
    SZPONT_BROWSER_DIR: config.browserDir,
    NO_COLOR: "1",
    TERM: "dumb",
  };
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
    message.thread &&
    message.parentId === config.parentId &&
    message.content.trim().length > 0 &&
    message.content.length <= MAX_MESSAGE &&
    Buffer.byteLength(message.content, "utf8") <= 32_000 &&
    message.attachments === 0
  );
}
