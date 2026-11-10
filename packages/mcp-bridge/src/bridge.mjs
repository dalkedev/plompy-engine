import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  McpError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { serviceDefinition } from "./services.mjs";

export const limits = Object.freeze({
  inputBytes: 2_097_152,
  responseBytes: 8_388_608,
  requestMs: 180_000,
  connectMs: 15_000,
  concurrent: 4,
});
const failure = () =>
  new McpError(
    ErrorCode.InternalError,
    "Managed MCP request failed or timed out. Remote completion may be uncertain; inspect the service before retrying.",
  );

export function redact(value, token) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limits.responseBytes) throw failure();
  const visit = (item, depth = 0) => {
    if (depth > 64) throw failure();
    if (typeof item === "string") return item.split(token).join("[REDACTED]");
    if (Array.isArray(item)) return item.map((part) => visit(part, depth + 1));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, part]) => [
          key.split(token).join("[REDACTED]"),
          visit(part, depth + 1),
        ]),
      );
    return item;
  };
  return visit(value);
}

// Transport injection exists for offline tests only. The executable never accepts
// a destination, header, timeout or environment-variable override.
export function createBoundedFetch(
  serviceId,
  token,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = limits.requestMs,
    maxBytes = limits.responseBytes,
  } = {},
) {
  const service = serviceDefinition(serviceId),
    endpoint = service.endpoints["api-key"];
  let active = 0;
  return async (input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    if (url !== endpoint || !["GET", "POST", "DELETE"].includes(method))
      throw failure();
    // All four vendors support request/response MCP. Do not create a second,
    // reconnecting background stream or advertise resource subscriptions.
    if (method === "GET") return new Response(null, { status: 405 });
    if (
      active >= limits.concurrent + 2 ||
      (options.body &&
        (typeof options.body !== "string" ||
          Buffer.byteLength(options.body) > limits.inputBytes))
    )
      throw failure();
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    let reader,
      released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      active--;
      options.signal?.removeEventListener("abort", abort);
    };
    try {
      const headers = new Headers();
      const provided = new Headers(options.headers);
      for (const name of [
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
      ]) {
        const value = provided.get(name);
        if (value !== null) {
          if (value.length > 4096) throw failure();
          headers.set(name, value);
        }
      }
      headers.set(service.header, service.prefix + token);
      for (const [name, value] of Object.entries(service.headers ?? {}))
        headers.set(name, value);
      const response = await new Promise((resolve, reject) => {
        const expired = () => reject(failure());
        controller.signal.addEventListener("abort", expired, { once: true });
        if (controller.signal.aborted) {
          expired();
          return;
        }
        Promise.resolve()
          .then(() =>
            fetchImpl(endpoint, {
              method,
              headers,
              body: options.body,
              redirect: "manual",
              signal: controller.signal,
              credentials: "omit",
            }),
          )
          .then(
            (response) => {
              controller.signal.removeEventListener("abort", expired);
              if (controller.signal.aborted) {
                response.body?.cancel().catch(() => {});
                reject(failure());
              } else resolve(response);
            },
            (error) => {
              controller.signal.removeEventListener("abort", expired);
              reject(error);
            },
          );
      });
      // Never follow even same-origin redirects or inspect an error body, which
      // can echo credentials. SDK automatic auth/retries are not enabled.
      if (
        !response.ok ||
        response.status >= 300 ||
        Number(response.headers.get("content-length")) > maxBytes
      ) {
        response.body?.cancel().catch(() => {});
        throw failure();
      }
      const safeHeaders = new Headers();
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = response.headers.get(name);
        if (value !== null) {
          if (value.length > 4096) throw failure();
          safeHeaders.set(name, value);
        }
      }
      if (!response.body) {
        release();
        return new Response(null, {
          status: response.status,
          headers: safeHeaders,
        });
      }
      reader = response.body.getReader();
      let bytes = 0;
      const body = new ReadableStream({
        async pull(output) {
          try {
            const next = await reader.read();
            if (controller.signal.aborted) throw failure();
            if (next.done) {
              release();
              output.close();
              return;
            }
            bytes += next.value.byteLength;
            if (bytes > maxBytes || controller.signal.aborted) throw failure();
            output.enqueue(next.value);
          } catch {
            controller.abort();
            reader.cancel().catch(() => {});
            release();
            output.error(failure());
          }
        },
        cancel() {
          controller.abort();
          reader.cancel().catch(() => {});
          release();
        },
      });
      // A stalled response body must end even when a fake/test fetch ignores
      // AbortSignal, as must an idle event-stream with no next chunk.
      controller.signal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
          release();
        },
        { once: true },
      );
      return new Response(body, {
        status: response.status,
        headers: safeHeaders,
      });
    } catch {
      controller.abort();
      reader?.cancel().catch(() => {});
      release();
      throw failure();
    }
  };
}

const methodCapabilities = Object.freeze({
  "tools/list": "tools",
  "tools/call": "tools",
  "resources/list": "resources",
  "resources/templates/list": "resources",
  "resources/read": "resources",
  "prompts/list": "prompts",
  "prompts/get": "prompts",
  "completion/complete": "completions",
});

export async function createBridge({
  serviceId,
  token,
  fetchImpl,
  stdin = process.stdin,
  stdout = process.stdout,
  requestMs = limits.requestMs,
  connectMs = limits.connectMs,
}) {
  const service = serviceDefinition(serviceId);
  const client = new Client(
    { name: "szpont-mcp-bridge", version: "0.1.0" },
    { capabilities: {} },
  );
  const remote = new StreamableHTTPClientTransport(
    new URL(service.endpoints["api-key"]),
    {
      fetch: createBoundedFetch(serviceId, token, {
        fetchImpl,
        timeoutMs: requestMs,
      }),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    },
  );
  // SDK transport/schema error objects may contain remote bodies. Never log them.
  client.onerror = () => {};
  try {
    await client.connect(remote, { timeout: connectMs });
  } catch {
    await client.close().catch(() => {});
    throw failure();
  }
  const upstream = client.getServerCapabilities() ?? {};
  const capabilities = {};
  if (upstream.tools) capabilities.tools = { listChanged: false };
  if (upstream.resources)
    capabilities.resources = { subscribe: false, listChanged: false };
  if (upstream.prompts) capabilities.prompts = { listChanged: false };
  if (upstream.completions) capabilities.completions = {};
  const server = new Server(
    { name: `szpont-${serviceId}`, version: "0.1.0" },
    { capabilities },
  );
  let running = 0,
    closing;
  server.fallbackRequestHandler = async (request, extra) => {
    if (
      !capabilities[methodCapabilities[request.method]] ||
      request.params?.task
    )
      throw new McpError(
        ErrorCode.MethodNotFound,
        "Unsupported MCP bridge method or capability.",
      );
    if (running >= limits.concurrent)
      throw new McpError(
        ErrorCode.InvalidRequest,
        "MCP bridge concurrency limit reached.",
      );
    running++;
    try {
      const progressToken = request.params?._meta?.progressToken;
      const response = await client.request(
        {
          method: request.method,
          ...(request.params ? { params: request.params } : {}),
        },
        ResultSchema,
        {
          signal: extra.signal,
          timeout: requestMs,
          maxTotalTimeout: requestMs,
          ...(progressToken === undefined
            ? {}
            : {
                onprogress: (progress) => {
                  extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: { ...redact(progress, token), progressToken },
                    })
                    .catch(() => {});
                },
              }),
        },
      );
      return redact(response, token);
    } catch {
      throw failure();
    } finally {
      running--;
    }
  };
  const local = new StdioServerTransport(stdin, stdout, {
    maxBufferSize: limits.inputBytes,
  });
  const close = () =>
    (closing ??= (async () => {
      // No tool replay and no stateful remote DELETE on uncertain shutdown. Closing
      // aborts outstanding HTTP streams and the SDK's pending request promises.
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    })());
  server.onerror = () => {};
  server.onclose = () => {
    void close();
  };
  stdin.once("end", () => {
    void close();
  });
  stdin.once("error", () => {
    void close();
  });
  await server.connect(local);
  return { server, client, close };
}
