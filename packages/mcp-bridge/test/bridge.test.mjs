import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createBoundedFetch,
  createBridge,
  limits,
  redact,
} from "../src/bridge.mjs";
import { remoteServiceIds, remoteServices } from "../src/services.mjs";

const token = "SYNTHETIC-PRIVATE-API-TOKEN";
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("Timed out waiting for synthetic protocol state");
};

for (const id of remoteServiceIds)
  test(`${id}: fixed destination and exact secret header, no inherited headers or background GET`, async () => {
    const calls = [];
    const fetch = createBoundedFetch(id, token, {
      fetchImpl: async (...args) => {
        calls.push(args);
        return json({ ok: true });
      },
    });
    assert.equal(
      (await fetch(remoteServices[id].endpoints["api-key"], { method: "GET" }))
        .status,
      405,
    );
    assert.equal(calls.length, 0);
    const response = await fetch(remoteServices[id].endpoints["api-key"], {
      method: "POST",
      headers: {
        Authorization: "wrong",
        "X-API-Key": "wrong",
        "x-posthog-read-only": "false",
        Cookie: "private-cookie",
        "mcp-session-id": "synthetic-session",
      },
      body: "{}",
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    const spec = remoteServices[id];
    assert.equal(url, spec.endpoints["api-key"]);
    assert.equal(options.headers.get(spec.header), spec.prefix + token);
    assert.equal(options.headers.get("cookie"), null);
    assert.equal(options.headers.get("mcp-session-id"), "synthetic-session");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    if (id === "posthog")
      assert.equal(options.headers.get("x-posthog-read-only"), "true");
    else assert.equal(options.headers.get("x-posthog-read-only"), null);
    await assert.rejects(
      fetch("https://attacker.example/mcp", { method: "POST", body: "{}" }),
    );
    await assert.rejects(
      fetch(url + "?override=true", { method: "POST", body: "{}" }),
    );
    await assert.rejects(fetch(url, { method: "PUT" }));
    assert.equal(calls.length, 1);
  });

test("redirects, authentication/rate/server failures never follow, retry or read an error body", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 429, 500]) {
    let calls = 0,
      cancelled = 0;
    const fetch = createBoundedFetch("perplexity", token, {
      fetchImpl: async () => {
        calls++;
        return {
          status,
          ok: false,
          headers: new Headers({
            location: "https://attacker.example/" + token,
          }),
          body: {
            cancel: async () => {
              cancelled++;
            },
          },
          text() {
            assert.fail("Error body was read");
          },
        };
      },
    });
    await assert.rejects(
      fetch(remoteServices.perplexity.endpoints["api-key"], {
        method: "POST",
        body: "{}",
      }),
      (error) => {
        assert.equal(error.message.includes(token), false);
        assert.equal(error.message.includes("attacker"), false);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
});

test("outbound input, response length and streamed bytes are bounded", async () => {
  let calls = 0;
  const fetch = createBoundedFetch("perplexity", token, {
    maxBytes: 8,
    fetchImpl: async () => {
      calls++;
      return new Response("123456789", {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    fetch(remoteServices.perplexity.endpoints["api-key"], {
      method: "POST",
      body: "x".repeat(limits.inputBytes + 1),
    }),
  );
  assert.equal(calls, 0);
  const response = await fetch(remoteServices.perplexity.endpoints["api-key"], {
    method: "POST",
    body: "{}",
  });
  await assert.rejects(response.text());
  const lengthFetch = createBoundedFetch("perplexity", token, {
    maxBytes: 8,
    fetchImpl: async () =>
      new Response("x", { headers: { "content-length": "9" } }),
  });
  await assert.rejects(
    lengthFetch(remoteServices.perplexity.endpoints["api-key"], {
      method: "POST",
      body: "{}",
    }),
  );
});

test("a stalled response body is cancelled at its total deadline", async () => {
  let cancelled = false;
  const fetch = createBoundedFetch("perplexity", token, {
    timeoutMs: 15,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  const response = await fetch(remoteServices.perplexity.endpoints["api-key"], {
    method: "POST",
    body: "{}",
  });
  await assert.rejects(response.text());
  assert.equal(cancelled, true);
});

test("connection headers have a total deadline even if a fetch implementation ignores AbortSignal", async () => {
  let calls = 0;
  const fetch = createBoundedFetch("perplexity", token, {
    timeoutMs: 15,
    fetchImpl: async () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    fetch(remoteServices.perplexity.endpoints["api-key"], {
      method: "POST",
      body: "{}",
    }),
    /Managed MCP request failed/,
  );
  assert.equal(calls, 1);
});

test("redaction covers string values and object keys, including JSON-escaped token characters", () => {
  const key = 'quoted-"-token\\';
  const value = {
    [key]: [{ message: `Bearer ${key}`, nested: { value: key } }],
  };
  const result = redact(value, key);
  assert.deepEqual(result, {
    "[REDACTED]": [
      { message: "Bearer [REDACTED]", nested: { value: "[REDACTED]" } },
    ],
  });
});

function fakeRemote(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), remoteServices.perplexity.endpoints["api-key"]);
      assert.equal(options.headers.get("authorization"), `Bearer ${token}`);
      const request = JSON.parse(options.body);
      calls.push(request);
      if (request.method === "initialize")
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params.protocolVersion,
            serverInfo: { name: "synthetic-vendor", version: "1" },
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true },
              prompts: {},
              completions: {},
              logging: {},
              tasks: {},
            },
          },
        });
      if (!Object.hasOwn(request, "id"))
        return new Response(null, { status: 202 });
      return handler(request, options);
    },
  };
}

async function fixture(t, handler, options = {}) {
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const remote = fakeRemote(handler);
  const bridge = await createBridge({
    serviceId: "perplexity",
    token,
    fetchImpl: remote.fetchImpl,
    stdin,
    stdout,
    ...options,
  });
  let buffer = "";
  const local = {
    async start() {
      stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const i = buffer.indexOf("\n");
          if (i < 0) break;
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          this.onmessage?.(JSON.parse(line));
        }
      });
    },
    async send(message) {
      stdin.write(JSON.stringify(message) + "\n");
    },
    async close() {
      stdin.end();
      this.onclose?.();
    },
  };
  const client = new Client(
    { name: "synthetic-runner", version: "1" },
    { capabilities: {} },
  );
  await client.connect(local, { timeout: 500 });
  t.after(async () => {
    await client.close().catch(() => {});
    await bridge.close();
    stdin.destroy();
    stdout.destroy();
  });
  return { client, bridge, remote, stdin, stdout };
}

test("actual SDK stdio initialize, tools/list, tools/call and non-tool requests preserve request results", async (t) => {
  const f = await fixture(t, async (request) =>
    json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "tools/list"
          ? {
              tools: [
                {
                  name: "search",
                  description: "Synthetic search",
                  inputSchema: { type: "object" },
                },
              ],
            }
          : {
              content: [{ type: "text", text: `result ${token}` }],
              structuredContent: { echo: request.params },
            },
    }),
  );
  const caps = f.client.getServerCapabilities();
  assert.deepEqual(caps.tools, { listChanged: false });
  assert.deepEqual(caps.resources, { subscribe: false, listChanged: false });
  for (const unsupported of ["tasks", "logging", "sampling", "elicitation"])
    assert.equal(Object.hasOwn(caps, unsupported), false);
  assert.equal((await f.client.listTools()).tools[0].name, "search");
  const result = await f.client.callTool({
    name: "search",
    arguments: { query: "synthetic query" },
  });
  assert.equal(result.content[0].text, "result [REDACTED]");
  assert.equal(
    result.structuredContent.echo.arguments.query,
    "synthetic query",
  );
  for (const method of [
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
    "completion/complete",
  ]) {
    const result = await f.client.request({ method }, ResultSchema, {
      timeout: 500,
    });
    assert.equal(result.content[0].text, "result [REDACTED]");
  }
  await assert.rejects(
    f.client.request(
      { method: "resources/subscribe", params: { uri: "test://synthetic" } },
      ResultSchema,
      { timeout: 500 },
    ),
    /Unsupported MCP bridge/,
  );
  assert.equal(
    f.remote.calls.some((x) => x.method === "resources/subscribe"),
    false,
  );
});

test("remote JSON-RPC errors and HTTP errors have fixed sanitized local messages", async (t) => {
  const f = await fixture(t, async (request) =>
    request.params?.name === "http-error"
      ? new Response(token, { status: 500 })
      : json({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: token,
            data: { headers: `Bearer ${token}` },
          },
        }),
  );
  for (const name of ["rpc-error", "http-error"]) {
    await assert.rejects(f.client.callTool({ name }), (error) => {
      assert.match(error.message, /Managed MCP request failed/);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
  assert.equal(
    f.remote.calls.filter((x) => x.method === "tools/call").length,
    2,
  );
});

test("SSE progress and result relay use the runner progress token and redact credential echoes", async (t) => {
  const f = await fixture(t, async (request) => {
    const progress = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta.progressToken,
        progress: 1,
        total: 2,
        message: token,
      },
    };
    const result = {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "synthetic completed" }] },
    };
    return new Response(
      `event: message\ndata: ${JSON.stringify(progress)}\n\nevent: message\ndata: ${JSON.stringify(result)}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const progress = [];
  const result = await f.client.request(
    { method: "tools/call", params: { name: "search" } },
    ResultSchema,
    { timeout: 500, onprogress: (value) => progress.push(value) },
  );
  assert.equal(result.content[0].text, "synthetic completed");
  await until(() => progress.length === 1);
  assert.equal(progress[0].message, "[REDACTED]");
  assert.equal(progress[0].progress, 1);
});

test("cancellation propagates an MCP cancellation without replaying a pending tool call", async (t) => {
  const pending = [];
  const f = await fixture(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            pending.push(controller);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { requestMs: 1000 },
  );
  const controller = new AbortController();
  const request = f.client
    .request(
      { method: "tools/call", params: { name: "pending" } },
      ResultSchema,
      { signal: controller.signal, timeout: 500 },
    )
    .catch((error) => error);
  await until(() => pending.length === 1);
  controller.abort();
  await request;
  await until(() =>
    f.remote.calls.some((x) => x.method === "notifications/cancelled"),
  );
  assert.equal(
    f.remote.calls.filter((x) => x.method === "tools/call").length,
    1,
  );
});

test("four calls may run concurrently; excess work is rejected before upstream execution", async (t) => {
  const pending = [];
  const f = await fixture(
    t,
    async (request) =>
      new Response(
        new ReadableStream({
          start(controller) {
            pending.push({ request, controller });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { requestMs: 1000 },
  );
  const requests = Array.from({ length: 4 }, (_, i) =>
    f.client.request(
      { method: "tools/call", params: { name: `pending-${i}` } },
      ResultSchema,
      { timeout: 1500 },
    ),
  );
  await until(() => pending.length === 4);
  await assert.rejects(
    f.client.callTool({ name: "excess" }),
    /concurrency limit/,
  );
  assert.equal(pending.length, 4);
  for (const { request, controller } of pending) {
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [] } })}\n\n`,
      ),
    );
    controller.close();
  }
  assert.equal((await Promise.all(requests)).length, 4);
});

test("request timeout is bounded and does not replay an uncertain call", async (t) => {
  const f = await fixture(
    t,
    async () =>
      new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      }),
    { requestMs: 25 },
  );
  await assert.rejects(
    f.client.callTool({ name: "pending" }),
    /Managed MCP request failed/,
  );
  assert.equal(
    f.remote.calls.filter((x) => x.method === "tools/call").length,
    1,
  );
});

test("stdin EOF closes the upstream SDK session without remote writes or retries", async (t) => {
  const f = await fixture(t, async (request) =>
    json({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }),
  );
  f.stdin.end();
  await until(() => f.bridge.client.transport === undefined);
  assert.equal(
    f.remote.calls.some((x) => x.method === "tools/call"),
    false,
  );
});

test("an oversized unterminated stdio frame closes the relay before remote execution", async (t) => {
  const f = await fixture(t, async (request) =>
    json({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }),
  );
  f.stdin.write("x".repeat(limits.inputBytes + 1));
  await until(() => f.bridge.client.transport === undefined);
  assert.equal(
    f.remote.calls.some((x) => x.method === "tools/call"),
    false,
  );
});

test("invalid production CLI arguments cannot turn it into a custom endpoint or reveal values", async () => {
  const child = spawn(
    process.execPath,
    [
      new URL("../bridge.mjs", import.meta.url).pathname,
      "https://attacker.example/" + token,
      token,
    ],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (x) => {
    output += x;
  });
  child.stderr.on("data", (x) => {
    output += x;
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 1);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes("attacker"), false);
});
