import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  childEnvironment,
  MAX_OUTPUT,
  SESSION_ID,
  redact,
  type Config,
} from "./config.js";
import type { TurnResult } from "./runner.js";
import { validateWorkOutcome } from "./workflow.js";

/** Restricted mode and admin-required sandbox policy need this CLI version. */
export const CLAUDE_MIN_VERSION = "2.1.285";
export interface ClaudeOptions {
  workflow?: boolean;
  images?: readonly string[];
}
const workflowSchema = readFileSync(
  new URL("../schemas/workflow-output.schema.json", import.meta.url),
  "utf8",
);
const tools = "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch";

export function claudeArgs(
  config: Config,
  sessionId: string,
  resume: boolean,
  options: ClaudeOptions = {},
): string[] {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid resume session");
  const denyRead = [
    config.stateDir,
    config.codexHome,
    config.claudeHome,
    config.opencodeHome,
  ].filter((path): path is string => Boolean(path));
  const settings = {
    disableAllHooks: true,
    enabledPlugins: {},
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [config.artifactsDir, config.browserDir],
        denyRead,
      },
    },
  };
  const args = [
    "--restricted",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(settings),
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config",
    config.claudeMcpConfig ?? '{"mcpServers":{}}',
    "--tools",
    tools,
    "--allowedTools",
    config.claudeMcpConfig ? `${tools},mcp__*` : tools,
    "--permission-mode",
    "dontAsk",
    "--add-dir",
    config.artifactsDir,
    "--add-dir",
    config.browserDir,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    resume ? "--resume" : "--session-id",
    sessionId,
  ];
  if (config.claudeModel) args.push("--model", config.claudeModel);
  if (config.claudeEffort) args.push("--effort", config.claudeEffort);
  if (options.workflow) args.push("--json-schema", workflowSchema);
  return args;
}

function terminate(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  // A shell may exit while descendants retain its pipes. The escalation still
  // needs to kill the process group after its leader has already stopped.
  if (child.exitCode !== null && signal !== "SIGKILL") return;
  try {
    if (child.pid && process.platform !== "win32")
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* Already stopped. */
  }
}

export function supportedClaudeVersion(output: string): boolean {
  const version = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)\s*$/.exec(
    output.trim(),
  );
  if (!version) return false;
  const values = version.slice(1).map(Number),
    minimum = CLAUDE_MIN_VERSION.split(".").map(Number);
  if (values[0] !== minimum[0]) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (values[i]! > minimum[i]!) return true;
    if (values[i]! < minimum[i]!) return false;
  }
  return true;
}

/** Read-only CLI probes. Their output may identify the account, so never expose it. */
async function probe(
  config: Config,
  args: string[],
  capture: boolean,
  source: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(config.claudeBin ?? "claude", args, {
      cwd: config.workspace,
      env: childEnvironment({ ...config, provider: "claude" }, source),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      bytes = 0,
      stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      terminate(child, "SIGKILL");
    }, 10_000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65_536) {
        stopped = true;
        terminate(child, "SIGKILL");
      } else if (capture) output += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65_536) {
        stopped = true;
        terminate(child, "SIGKILL");
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !stopped ? output : null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

export async function claudeReady(
  config: Config,
  source: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const version = await probe(config, ["--version"], true, source);
  if (version === null || !supportedClaudeVersion(version)) return false;
  return (await probe(config, ["auth", "status"], false, source)) !== null;
}

export function runClaude(
  config: Config,
  prompt: string,
  sessionId: string | null,
  onSession: (id: string) => void,
  signal?: AbortSignal,
  options: ClaudeOptions = {},
): Promise<TurnResult> {
  if (options.images?.length)
    return Promise.resolve({
      ok: false,
      output: "",
      error: "unsupported_image_input",
      sessionId,
    });
  if (Buffer.byteLength(prompt) > 65_536)
    throw new Error("Assembled prompt exceeds limit");
  const expected = sessionId ?? randomUUID();
  const args = claudeArgs(config, expected, sessionId !== null, options);
  return probe(config, ["--version"], true, process.env).then((version) => {
    if (version === null || !supportedClaudeVersion(version)) {
      return {
        ok: false,
        output: "",
        error:
          version === null
            ? "claude_process_unavailable"
            : "claude_version_unsupported",
        sessionId,
      };
    }
    if (signal?.aborted) {
      return {
        ok: false,
        output: "",
        error: "owner_or_service_cancelled",
        sessionId,
      };
    }
    return new Promise<TurnResult>((resolve) => {
      const child = spawn(config.claudeBin ?? "claude", args, {
        cwd: config.workspace,
        env: childEnvironment({ ...config, provider: "claude" }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const decoder = new StringDecoder("utf8");
      let buffer = "",
        bytes = 0,
        stderrBytes = 0,
        output = "",
        observed = sessionId,
        error: string | null = null,
        initialized = false,
        completed = false,
        settled = false;
      let hardStop: NodeJS.Timeout | undefined;
      const stop = (code: string): void => {
        error ??= code;
        terminate(child);
        hardStop ??= setTimeout(() => terminate(child, "SIGKILL"), 3000);
      };
      const onAbort = (): void => stop("owner_or_service_cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop("task_timeout"), config.timeoutMs);
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardStop) clearTimeout(hardStop);
        signal?.removeEventListener("abort", onAbort);
        if (!observed && !error) error = "missing_session_id";
        resolve({
          ok: ok && !error && initialized && completed,
          output: redact(output.slice(0, MAX_OUTPUT), config.token),
          error:
            error ??
            (ok && initialized && completed ? null : "claude_turn_failed"),
          sessionId: observed,
        });
      };
      const event = (line: string): void => {
        if (error) return;
        if (!line.trim()) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          stop("invalid_claude_json");
          return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          stop("invalid_claude_event");
          return;
        }
        const e = value as Record<string, unknown>;
        if (e.type === "system" && e.subtype === "init") {
          if (
            e.session_id !== expected ||
            !SESSION_ID.test(String(e.session_id)) ||
            initialized
          ) {
            stop("session_identity_mismatch");
            return;
          }
          initialized = true;
          observed = expected;
          try {
            onSession(expected);
          } catch {
            stop("session_persistence_failed");
          }
        }
        if (e.type === "result") {
          if (!initialized || e.session_id !== expected) {
            stop("session_identity_mismatch");
            return;
          }
          if (completed) {
            stop("claude_duplicate_result");
            return;
          }
          if (e.subtype !== "success" || e.is_error !== false) {
            stop("claude_turn_failed");
            return;
          }
          let text: string;
          if (options.workflow) {
            try {
              text = JSON.stringify(
                validateWorkOutcome(JSON.stringify(e.structured_output)),
              );
            } catch {
              stop("workflow_output_invalid");
              return;
            }
          } else {
            if (typeof e.result !== "string") {
              stop("claude_result_invalid");
              return;
            }
            text = e.result;
          }
          if (
            text.length > MAX_OUTPUT ||
            Buffer.byteLength(text) > MAX_OUTPUT
          ) {
            stop("agent_output_limit");
            return;
          }
          output = text;
          completed = true;
        }
        if (e.type === "error") stop("claude_turn_failed");
      };
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024) {
          stop("event_stream_limit");
          return;
        }
        buffer += decoder.write(data);
        if (Buffer.byteLength(buffer) > 512 * 1024 && !buffer.includes("\n")) {
          stop("event_line_limit");
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > 512 * 1024) {
            stop("event_line_limit");
            return;
          }
          event(line);
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderrBytes += data.length;
        if (stderrBytes > 256 * 1024) stop("stderr_limit");
      });
      child.once("error", () => {
        error ??= "claude_process_unavailable";
        finish(false);
      });
      child.once("close", (code) => {
        buffer += decoder.end();
        if (buffer.trim()) event(buffer);
        finish(code === 0);
      });
      child.stdin.on("error", () => {});
      if (signal?.aborted) stop("owner_or_service_cancelled");
      else child.stdin.end(prompt);
    });
  });
}
