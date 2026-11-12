import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { isPublicAddress, assertPublicUrl, safeFetch, safeStreamFetch } from "../src/network.mjs";

async function fixture(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = `127.0.0.1:${server.address().port}`;
  return { server, host, url: `http://${host}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("public address policy rejects metadata, private, mapped and transition ranges", () => {
  for (const value of ["0.0.0.0", "10.1.2.3", "100.64.1.2", "127.0.0.1", "169.254.169.254", "172.20.1.2", "192.168.1.1", "192.0.2.1", "198.19.1.1", "198.51.100.8", "203.0.113.9", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "64:ff9b::7f00:1", "2001:10::1", "2001:20::1", "not-an-ip"])
    assert.equal(isPublicAddress(value), false, value);
  for (const value of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    assert.equal(isPublicAddress(value), true, value);
});

test("URL parser rejects encoded loopback forms, credentials, nonweb protocols and unusual ports", async () => {
  for (const url of ["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::ffff:127.0.0.1]", "file:///etc/passwd", "https://user:password@example.com/", "https://example.com:7331", "http://metadata.google.internal/", "http://localhost/"])
    await assert.rejects(assertPublicUrl(url), { code: "URL_BLOCKED" });
});

test("mixed public/private DNS answers fail before connection", async () => {
  await assert.rejects(assertPublicUrl("https://example.com", {
    resolveAddresses: async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
  }), { code: "URL_BLOCKED" });
});

test("IPv6 benchmark, special-assignment and documentation networks are not public destinations", () => {
  for (const value of ["2001:2::1", "2001:3::1", "2001:1ff:ffff::1", "3fff::1", "3fff:0fff::1"])
    assert.equal(isPublicAddress(value), false, value);
});

test("validated DNS is pinned into the actual request lookup", async () => {
  let resolutions = 0;
  let observed;
  const response = await safeFetch("https://example.com/", {
    resolveAddresses: async () => { resolutions++; return [{ address: "1.1.1.1", family: 4 }]; },
    requestImpl(url, options, callback) {
      observed = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter(); response.headers = { "content-type": "text/plain" }; response.statusCode = 200;
        callback(response); response.emit("data", Buffer.from("fixture")); response.emit("end");
      };
      return request;
    },
  });
  assert.equal(resolutions, 1);
  observed.lookup("example.com", {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, "1.1.1.1"); assert.equal(family, 4);
  });
  assert.equal(observed.agent, false);
  assert.equal(response.body.toString(), "fixture");
});

test("loopback fixture opt-in is exact, bounded and not the production default", async () => {
  const f = await fixture((_req, res) => { res.setHeader("Set-Cookie", "session=secret"); res.end("hello"); });
  try {
    await assert.rejects(safeFetch(f.url), { code: "URL_BLOCKED" });
    const result = await safeFetch(f.url, { allowHostsForTests: [f.host] });
    assert.equal(result.body.toString(), "hello"); assert.equal(result.headers["set-cookie"], undefined);
    await assert.rejects(safeFetch(f.url, { allowHostsForTests: [f.host], maxBytes: 3 }), { code: "RESPONSE_TOO_LARGE" });
  } finally { await f.close(); }
});

test("redirects are returned by default and public validation repeats when explicitly followed", async () => {
  const f = await fixture((req, res) => {
    if (req.url === "/ok") return res.end("ok");
    res.writeHead(302, { location: req.url === "/safe" ? "/ok" : "http://169.254.169.254/latest/meta-data" }); res.end();
  });
  try {
    const options = { allowHostsForTests: [f.host] };
    assert.equal((await safeFetch(f.url, options)).status, 302);
    await assert.rejects(safeFetch(f.url, { ...options, followRedirects: true }), { code: "URL_BLOCKED" });
    const result = await safeFetch(`${f.url}/safe`, { ...options, followRedirects: true });
    assert.equal(result.url, `${f.url}/ok`); assert.equal(result.body.toString(), "ok");
  } finally { await f.close(); }
});

test("SDK POST supports bounded explicit auth without redirect or retry", async () => {
  let hits = 0;
  const f = await fixture((req, res) => {
    hits++; assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, "Bearer synthetic-test");
    res.writeHead(302, { location: "/again", "mcp-session-id": "fixture-session" }); res.end();
  });
  try {
    const result = await safeFetch(f.url, { allowHostsForTests: [f.host], method: "POST", body: "{}", headers: { Authorization: "Bearer synthetic-test" } });
    assert.equal(hits, 1); assert.equal(result.status, 302); assert.equal(result.headers["mcp-session-id"], "fixture-session");
    await assert.rejects(safeFetch(f.url, { method: "POST", followRedirects: true }), { code: "REDIRECT_BLOCKED" });
    await assert.rejects(safeFetch(f.url, { headers: { Cookie: "forbidden" } }), { code: "HEADER_BLOCKED" });
    await assert.rejects(safeFetch(f.url, { headers: { Authorization: "Bearer test" }, followRedirects: true }), { code: "REDIRECT_BLOCKED" });
  } finally { await f.close(); }
});

test("aborts stop DNS wait and pending body; no raw server error content escapes", async () => {
  const controller = new AbortController();
  const pending = safeFetch("https://example.com", { signal: controller.signal, resolveAddresses: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending);
  const f = await fixture((_req, res) => { res.write("partial"); });
  try {
    const controller = new AbortController();
    const pending = safeFetch(f.url, { allowHostsForTests: [f.host], signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending);
  } finally { f.server.closeAllConnections(); await f.close(); }
});

test("MCP streaming returns a complete SSE frame without waiting for EOF, then cancels the socket", async () => {
  let socketClosed;
  const closed = new Promise((resolve) => { socketClosed = resolve; });
  const f = await fixture((_request, response) => {
    response.on("close", socketClosed);
    response.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "secret=fixture" });
    response.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    // Deliberately keep the vendor socket open after returning a result.
  });
  try {
    const response = await safeStreamFetch(f.url, { allowHostsForTests: [f.host], body: "{}", timeoutMs: 1000 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"result"/);
    assert.equal(first.done, false);
    await reader.cancel();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Underlying socket was not cancelled.")), 500))]);
  } finally { f.server.closeAllConnections(); await f.close(); }
});

test("MCP streaming enforces body and time limits after headers arrive", async () => {
  const f = await fixture((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(request.url === "/large" ? "too many bytes" : "start");
  });
  try {
    const large = await safeStreamFetch(`${f.url}/large`, { allowHostsForTests: [f.host], body: "{}", maxBytes: 4 });
    await assert.rejects(large.text(), { code: "RESPONSE_TOO_LARGE" });
    const timed = await safeStreamFetch(f.url, { allowHostsForTests: [f.host], body: "{}", timeoutMs: 30 });
    await assert.rejects(timed.text(), { code: "FETCH_CANCELLED" });
  } finally { f.server.closeAllConnections(); await f.close(); }
});

test("MCP streaming rejects redirects and default private endpoints before forwarding credentials", async () => {
  const f = await fixture((_request, response) => { response.writeHead(302, { location: "/again" }); response.end(); });
  try {
    await assert.rejects(safeStreamFetch(f.url, { body: "{}" }), { code: "URL_BLOCKED" });
    await assert.rejects(safeStreamFetch(f.url, { body: "{}", allowHostsForTests: [f.host] }), { code: "REDIRECT_BLOCKED" });
    await assert.rejects(safeStreamFetch(f.url, { method: "GET", body: "{}" }), { code: "METHOD_BLOCKED" });
  } finally { await f.close(); }
});
