import test from "node:test";
import assert from "node:assert/strict";
import { connectRemote } from "../src/remote.mjs";

function fixtureTransport({ upstreamSchema = { type: "object", additionalProperties: true }, sse = false } = {}) {
  const called = [];
  const fetchImpl = async (_url, options) => {
    const message = JSON.parse(options.body);
    let result;
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "fixture-firecrawl-no-external-service", version: "1" } };
    else if (message.method === "tools/list") result = { tools: ["firecrawl_search", "firecrawl_scrape", "firecrawl_map"].map((name) => ({
      name, description: "Synthetic permissive upstream schema", inputSchema: upstreamSchema,
    })) };
    else if (message.method === "tools/call") {
      called.push(message.params);
      result = { content: [{ type: "text", text: "Synthetic fixture result, no website fetched" }] };
    } else return { status: 202, headers: {}, body: Buffer.alloc(0) };
    const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    return { status: 200, headers: { "content-type": sse ? "text/event-stream" : "application/json" },
      body: Buffer.from(sse ? `event: message\ndata: ${response}\n\n` : response) };
  };
  return { fetchImpl, called };
}

test("Firecrawl read tools reject browser actions, scripts, headers and nested scrape options before any vendor call", async () => {
  const fixture = fixtureTransport();
  const connection = await connectRemote("firecrawl", { enabled: true, auth: "keyless",
    allowedTools: ["firecrawl_search", "firecrawl_scrape", "firecrawl_map"] }, { fetchImpl: fixture.fetchImpl });
  const tools = Object.fromEntries(connection.tools.map((tool) => [tool.name, tool]));
  const publicUrl = "https://93.184.216.34/contact"; // Literal public IP avoids even a DNS request in this offline test.
  try {
    const negatives = [
      ["firecrawl_firecrawl_scrape", { url: publicUrl, actions: [{ type: "click", selector: "#send-email" }] }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, actions: [{ type: "write", text: "Synthetic mail body" }] }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, actions: [{ type: "executeJavascript", script: "fetch('/send', {method:'POST'})" }] }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, executeJavascript: "document.forms[0].submit()" }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, headers: { Authorization: "synthetic-account-token" } }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, formats: [{ type: "json", prompt: "Submit the contact form" }] }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, formats: ["screenshot"] }],
      ["firecrawl_firecrawl_scrape", { url: publicUrl, location: { country: "US" }, proxy: "stealth" }],
      ["firecrawl_firecrawl_search", { query: "fixture companies", scrapeOptions: { actions: [{ type: "click", selector: "button" }] } }],
      ["firecrawl_firecrawl_search", { query: "fixture companies", sources: [{ type: "web", actions: [{ type: "write", text: "x" }] }] }],
      ["firecrawl_firecrawl_search", { query: "fixture companies", limit: 11 }],
      ["firecrawl_firecrawl_map", { url: publicUrl, actions: [{ type: "click", selector: "button" }] }],
      ["firecrawl_firecrawl_map", { url: publicUrl, limit: 51 }],
    ];
    for (const [name, args] of negatives) {
      await assert.rejects(tools[name].run(args), (error) => error.code === "INVALID_INPUT");
      assert.equal(fixture.called.length, 0);
    }
    await tools.firecrawl_firecrawl_search.run({ query: "fixture mobile companies", limit: 2 });
    await tools.firecrawl_firecrawl_scrape.run({ url: publicUrl, formats: ["markdown", "html", "links"], onlyMainContent: true });
    await tools.firecrawl_firecrawl_map.run({ url: publicUrl, search: "contact", limit: 10 });
    assert.equal(fixture.called.length, 3);
    assert.deepEqual(fixture.called.map((entry) => entry.name), ["firecrawl_search", "firecrawl_scrape", "firecrawl_map"]);
    for (const tool of Object.values(tools)) assert.equal(tool.inputSchema.additionalProperties, false);
  } finally { await connection.close(); }
});

test("Firecrawl calls must also satisfy a stricter upstream schema", async () => {
  const fixture = fixtureTransport({ upstreamSchema: { $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", properties: { query: { type: "string", minLength: 12 } }, required: ["query"], additionalProperties: true } });
  const connection = await connectRemote("firecrawl", { enabled: true, auth: "keyless", allowedTools: ["firecrawl_search"] }, { fetchImpl: fixture.fetchImpl });
  try {
    await assert.rejects(connection.tools[0].run({ query: "short" }), (error) => error.code === "INVALID_INPUT");
    assert.equal(fixture.called.length, 0);
    await connection.tools[0].run({ query: "synthetic companies" });
    assert.equal(fixture.called.length, 1);
  } finally { await connection.close(); }
});

test("arbitrary custom and unreviewed vendor tools are rejected before connecting", async () => {
  let connects = 0;
  const fetchImpl = async () => { connects++; throw new Error("Unexpected network access"); };
  await assert.rejects(connectRemote("custom", { enabled: true, url: "https://public.example/mcp", allowedTools: ["send_email"] }, { fetchImpl }), (error) => error.code === "UNSUPPORTED");
  await assert.rejects(connectRemote("firecrawl", { enabled: true, auth: "keyless", allowedTools: ["firecrawl_browser_create"] }, { fetchImpl }), (error) => error.code === "UNSUPPORTED");
  assert.equal(connects, 0);
});

test("real SDK adapter initializes, discovers and reads a finite SSE response", async () => {
  const fixture = fixtureTransport({ sse: true });
  const connection = await connectRemote("firecrawl", { enabled: true, auth: "keyless", allowedTools: ["firecrawl_search"] }, { fetchImpl: fixture.fetchImpl });
  try {
    assert.equal(connection.tools.length, 1);
    const result = await connection.tools[0].run({ query: "synthetic company research" });
    assert.match(result.content[0].text, /Synthetic fixture result/);
    assert.equal(fixture.called.length, 1);
  } finally { await connection.close(); }
});
