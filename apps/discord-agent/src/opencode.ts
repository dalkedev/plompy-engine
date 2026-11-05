import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { childEnvironment, MAX_OUTPUT, redact, type Config } from "./config.js";
import type { RunnerOptions, TurnResult } from "./runner.js";
import { validateWorkOutcome } from "./workflow.js";

// Reviewed against the immutable upstream v1.19.5 source. New CLI majors must
// pass separate protocol/permission acceptance before this pin is changed.
export const OPENCODE_VERSION = "1.19.5";
export const OPENCODE_SESSION_ID = /^ses_[a-zA-Z0-9]{26}$/;
const MAX_CONFIG_BYTES = 65_536;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[^\s\u0000-\u001f]{1,200}$/;

function enabled(config: Config): boolean {
  return (
    config.opencodeAllowHostExecution === true &&
    typeof config.opencodeHome === "string" &&
    typeof config.opencodeModel === "string" &&
    MODEL.test(config.opencodeModel)
  );
}

async function privateJson(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES)
    throw new Error("Invalid private OpenCode file");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid private OpenCode file");
  return value as Record<string, unknown>;
}

/** Only explicitly supplied operator provider/MCP config is accepted. */
async function environment(
  config: Config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const trusted = config.opencodeConfig
    ? await privateJson(config.opencodeConfig)
    : {};
  if (Object.keys(trusted).some((key) => key !== "provider" && key !== "mcp"))
    throw new Error("Unsupported OpenCode config key");
  for (const key of ["provider", "mcp"]) {
    if (
      trusted[key] !== undefined &&
      (!trusted[key] ||
        typeof trusted[key] !== "object" ||
        Array.isArray(trusted[key]))
    )
      throw new Error("Invalid OpenCode config object");
  }
  const permission: Record<string, unknown> = {
    "*": "deny",
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    bash: "allow",
    task: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    skill: "allow",
    external_directory: {
      "*": "deny",
      [config.artifactsDir + "/**"]: "allow",
      [config.browserDir + "/**"]: "allow",
    },
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
  };
  for (const name of Object.keys(
    (trusted.mcp ?? {}) as Record<string, unknown>,
  )) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new Error("Invalid MCP server name");
    permission[name + "_*"] = "allow";
  }
  return {
    ...childEnvironment({ ...config, provider: "opencode" }, source),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...trusted,
      model: config.opencodeModel,
      enabled_providers: [config.opencodeModel!.split("/")[0]],
      autoupdate: false,
      share: "disabled",
      plugin: [],
      formatter: false,
      lsp: false,
      permission,
      default_agent: "build",
    }),
    OPENCODE_PERMISSION: JSON.stringify(permission),
  };
}

function versionReady(
  config: Config,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(config.opencodeBin ?? "opencode", ["--version"], {
      cwd: config.workspace,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "",
      settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 4096) {
        child.kill("SIGKILL");
        finish(false);
      }
    });
    child.once("error", () => finish(false));
    child.once("close", (code) =>
      finish(code === 0 && output.trim() === OPENCODE_VERSION),
    );
  });
}

/** Local prerequisites only: this never calls a model or proves remote auth. */
export async function opencodeReady(
  config: Config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!enabled(config)) return false;
  try {
    const env = await environment(config, source);
    const auth = await privateJson(
      join(config.opencodeHome!, "data", "opencode", "auth.json"),
    );
    const value = auth[config.opencodeModel!.split("/")[0]!];
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const entry = value as Record<string, unknown>;
    // Remote .well-known config and arbitrary environment API keys are excluded.
    if (entry.type === "api") {
      if (typeof entry.key !== "string" || !entry.key.trim()) return false;
    } else if (entry.type === "oauth") {
      if (
        typeof entry.access !== "string" ||
        !entry.access ||
        typeof entry.refresh !== "string" ||
        !entry.refresh ||
        typeof entry.expires !== "number" ||
        !Number.isSafeInteger(entry.expires) ||
        entry.expires < 0
      )
        return false;
    } else return false;
    return await versionReady(config, env);
  } catch {
    return false;
  }
}

export function opencodeArgs(
  config: Config,
  sessionId: string | null,
): string[] {
  if (!config.opencodeModel || !MODEL.test(config.opencodeModel))
    throw new Error("OpenCode requires provider/model");
  if (sessionId && !OPENCODE_SESSION_ID.test(sessionId))
    throw new Error("Invalid OpenCode resume session");
  return [
    "run",
    "--format",
    "json",
    "--model",
    config.opencodeModel,
    "--agent",
    "build",
    "--dir",
    config.workspace,
    ...(sessionId ? ["--session", sessionId] : []),
  ];
}

function terminate(child: ChildProcessWithoutNullStreams, hard = false): void {
  // A reaped CLI leader can leave descendants holding the output pipes. The
  // hard deadline must still kill its detached process group in that case.
  if (!hard && child.exitCode !== null) return;
  try {
    const signal = hard ? "SIGKILL" : "SIGTERM";
    if (child.pid && process.platform !== "win32")
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* Already stopped. */
  }
}

export async function runOpenCode(
  config: Config,
  prompt: string,
  sessionId: string | null,
  onSession: (id: string) => void,
  signal?: AbortSignal,
  options: RunnerOptions = {},
): Promise<TurnResult> {
  const failure = (error: string): TurnResult => ({
    ok: false,
    output: "",
    error,
    sessionId,
  });
  if (options.images?.length) return failure("unsupported_image_input");
  if (!config.opencodeAllowHostExecution)
    return failure("opencode_host_execution_not_enabled");
  const args = opencodeArgs(config, sessionId);
  if (options.workflow) {
    const schema = await readFile(
      new URL("../schemas/workflow-output.schema.json", import.meta.url),
      "utf8",
    );
    prompt += `\nReturn exactly one JSON checkpoint matching this schema, without surrounding prose or Markdown:\n${schema}`;
  }
  if (Buffer.byteLength(prompt) > 65_536)
    throw new Error("Assembled prompt exceeds limit");
  if (signal?.aborted) return failure("owner_or_service_cancelled");
  if (!(await opencodeReady(config)))
    return failure("opencode_local_prerequisites_unavailable");
  let env: NodeJS.ProcessEnv;
  try {
    env = await environment(config);
  } catch {
    return failure("opencode_configuration_invalid");
  }
  if (signal?.aborted) return failure("owner_or_service_cancelled");
  return new Promise((resolve) => {
    const child = spawn(config.opencodeBin ?? "opencode", args, {
      cwd: config.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "",
      bytes = 0,
      stderrBytes = 0,
      output = "",
      observed = sessionId;
    let error: string | null = null,
      completed = false,
      started = false,
      settled = false,
      announced = false;
    let messageId: string | null = null;
    const textParts = new Map<string, string>();
    let hardStop: NodeJS.Timeout | undefined;
    const stop = (reason: string): void => {
      error ??= reason;
      terminate(child);
      hardStop ??= setTimeout(() => terminate(child, true), 3000);
    };
    const abort = (): void => stop("owner_or_service_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("task_timeout"), config.timeoutMs);
    const finish = (processOk: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      signal?.removeEventListener("abort", abort);
      if (!observed) error ??= "missing_session_id";
      if (!processOk) error ??= "opencode_turn_failed";
      if (!completed || !output.trim()) error ??= "opencode_turn_incomplete";
      if (!error && options.workflow) {
        try {
          validateWorkOutcome(output);
        } catch {
          error = "workflow_output_invalid";
        }
      }
      resolve({
        ok: !error,
        output: redact(output.slice(0, MAX_OUTPUT), config.token),
        error,
        sessionId: observed,
      });
    };
    const event = (line: string): void => {
      if (!line.trim() || error) return;
      if (Buffer.byteLength(line) > 512 * 1024) {
        stop("event_line_limit");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        stop("invalid_opencode_json");
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        stop("invalid_opencode_event");
        return;
      }
      const e = value as Record<string, unknown>;
      if (
        typeof e.type !== "string" ||
        typeof e.sessionID !== "string" ||
        !OPENCODE_SESSION_ID.test(e.sessionID) ||
        (observed && e.sessionID !== observed)
      ) {
        stop("session_identity_mismatch");
        return;
      }
      observed = e.sessionID;
      if (!announced) {
        announced = true;
        try {
          onSession(observed);
        } catch {
          stop("session_persistence_failed");
          return;
        }
      }
      if (e.type === "error") {
        stop("opencode_turn_failed");
        return;
      }
      if (
        ![
          "step_start",
          "step_finish",
          "text",
          "tool_use",
          "reasoning",
        ].includes(e.type)
      ) {
        stop("invalid_opencode_event");
        return;
      }
      if (!e.part || typeof e.part !== "object" || Array.isArray(e.part)) {
        stop("invalid_opencode_event");
        return;
      }
      const part = e.part as Record<string, unknown>;
      if (
        part.sessionID !== observed ||
        typeof part.messageID !== "string" ||
        typeof part.id !== "string"
      ) {
        stop("session_identity_mismatch");
        return;
      }
      if (e.type === "step_start") {
        if (part.type !== "step-start") {
          stop("invalid_opencode_event");
          return;
        }
        started = true;
        completed = false;
        if (part.messageID !== messageId) {
          messageId = part.messageID;
          textParts.clear();
          output = "";
        }
      }
      if (e.type === "step_finish") {
        if (
          !started ||
          part.messageID !== messageId ||
          part.type !== "step-finish" ||
          typeof part.reason !== "string"
        ) {
          stop("invalid_opencode_event");
          return;
        }
        completed = part.reason === "stop";
      }
      if (e.type === "text") {
        if (
          !started ||
          part.messageID !== messageId ||
          part.type !== "text" ||
          typeof part.text !== "string"
        ) {
          stop("invalid_opencode_event");
          return;
        }
        textParts.set(part.id, part.text);
        output = [...textParts.values()].join("\n");
        if (output.length > MAX_OUTPUT) stop("agent_output_limit");
      }
    };
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) {
        stop("event_stream_limit");
        return;
      }
      buffer += decoder.write(data);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        event(line);
      }
      if (Buffer.byteLength(buffer) > 512 * 1024) stop("event_line_limit");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 256 * 1024) stop("stderr_limit");
    });
    child.once("error", () => {
      error ??= "opencode_process_unavailable";
      finish(false);
    });
    child.once("close", (code) => {
      buffer += decoder.end();
      if (buffer.trim()) event(buffer);
      finish(code === 0);
    });
    child.stdin.on("error", () => {
      /* Process handlers settle. */
    });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}
