import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const forbidden = () => fail("URL_BLOCKED", "Only public HTTP(S) websites on standard ports are allowed.");

function ipv4Number(address) {
  return address.split(".").reduce((number, part) => (number * 256 + Number(part)) >>> 0, 0);
}

const blockedV4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4Number(base), bits]);

function ipv6Number(address) {
  if (address.includes(".") || address.includes("%")) return null;
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return groups.reduce((number, part) => (number << 16n) | BigInt(`0x${part}`), 0n);
}

/** Conservative public-unicast allowlist; no IPv4-mapped, NAT64 or 6to4 bypass. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const number = ipv4Number(address);
    return !blockedV4.some(([base, bits]) => number >>> (32 - bits) === base >>> (32 - bits));
  }
  if (family !== 6) return false;
  const number = ipv6Number(address);
  if (number === null || number >> 125n !== 1n) return false; // 2000::/3 only
  if (number >> 105n === (0x2001n << 7n)) return false; // IETF special assignments 2001::/23
  if (number >> 108n === 0x3fff0n) return false; // documentation 3fff::/20
  const prefix32 = number >> 96n;
  if (number >> 112n === 0x2002n) return false; // 6to4 embeds another address
  if (prefix32 === 0x20010db8n || prefix32 === 0x20010000n) return false;
  if (number >> 100n === 0x2001001n || number >> 100n === 0x2001002n) return false;
  return true;
}

function parseUrl(value, allowHostsForTests = []) {
  let url;
  try { url = new URL(value); } catch { throw forbidden(); }
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw forbidden();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw forbidden();
  const fixture = Array.isArray(allowHostsForTests) && allowHostsForTests.includes(url.host);
  if (!fixture && url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) throw forbidden();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!fixture && (hostname === "localhost" || /\.(localhost|local|internal)$/i.test(hostname))) throw forbidden();
  url.hash = "";
  return { url, hostname, fixture };
}

/** The test exception is dependency injection only, never loaded from configuration. */
export async function assertPublicUrl(value, { allowHostsForTests = [], resolveAddresses = dnsLookup, signal } = {}) {
  const parsed = parseUrl(value, allowHostsForTests);
  const { hostname, fixture } = parsed;
  let addresses;
  try {
    if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
    else {
      const resolution = resolveAddresses(hostname, { all: true, verbatim: true });
      if (!signal) addresses = await resolution;
      else {
        let abort;
        try {
          signal.throwIfAborted();
          addresses = await Promise.race([resolution, new Promise((_, reject) => {
            abort = () => reject(new Error("cancelled"));
            signal.addEventListener("abort", abort, { once: true });
          })]);
        } finally { signal.removeEventListener("abort", abort); }
      }
    }
  } catch { throw fail("DNS_FAILED", "The website name could not be resolved."); }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32 ||
      addresses.some(({ address, family }) => !isIP(address) || isIP(address) !== family || (!fixture && !isPublicAddress(address)))) throw forbidden();
  return { ...parsed, addresses };
}

function connectionOptions(target, { method, signal, headers }) {
  const address = target.addresses[0];
  return {
    method, signal, agent: false, autoSelectFamily: false, family: address.family,
    // Exactly the address validated above is used. No second DNS lookup or proxy env.
    lookup(_hostname, options, callback) {
      callback(null, options.all ? [address] : address.address, address.family);
    },
    headers: {
      "user-agent": "PlompyLocal/1.0 (public website research)",
      accept: "text/html,application/xhtml+xml,application/json,text/plain,text/css,application/javascript;q=0.8,*/*;q=0.1",
      "accept-encoding": "identity",
      ...headers,
    },
    maxHeaderSize: 16 * 1024,
  };
}

function responseHeaders(response) {
  // No cookies, authentication headers or raw provider diagnostics reach callers.
  const headers = {};
  for (const name of ["content-type", "location", "cache-control", "last-modified", "retry-after", "mcp-session-id", "mcp-protocol-version"])
    if (typeof response.headers[name] === "string") headers[name] = response.headers[name];
  return headers;
}

function validatedHeaders(headers = {}, followRedirects = false) {
  const safe = {};
  const permitted = new Set(["accept", "content-type", "authorization", "x-api-key", "x-posthog-read-only", "mcp-session-id", "mcp-protocol-version", "last-event-id", "context7_api_key"]);
  for (const [name, value] of Object.entries(headers)) {
    if (!permitted.has(name.toLowerCase()) || typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value))
      throw fail("HEADER_BLOCKED", "Unsupported transport header.");
    safe[name.toLowerCase()] = value;
  }
  if (followRedirects && Object.keys(safe).some((name) => !["accept", "content-type"].includes(name)))
    throw fail("REDIRECT_BLOCKED", "Credential-bearing requests never follow redirects.");
  return safe;
}

function pinnedRequest(target, { signal, maxBytes, method, requestImpl, headers, body }) {
  return new Promise((resolve, reject) => {
    const transport = requestImpl ?? (target.url.protocol === "https:" ? https.request : http.request);
    const request = transport(target.url, connectionOptions(target, { method, signal, headers }), (response) => {
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") {
        response.destroy();
        reject(fail("ENCODING_UNSUPPORTED", "The website ignored the bounded uncompressed response request."));
        return;
      }
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy(); reject(fail("RESPONSE_TOO_LARGE", "The website response exceeds the size limit.")); return;
      }
      const chunks = []; let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(); reject(fail("RESPONSE_TOO_LARGE", "The website response exceeds the size limit."));
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(fail("FETCH_FAILED", "The website response was interrupted.")));
      response.on("end", () => {
        resolve({ url: target.url.href, status: response.statusCode, headers: responseHeaders(response), body: Buffer.concat(chunks) });
      });
    });
    request.on("error", () => reject(signal.aborted
      ? fail("FETCH_CANCELLED", "The website request timed out or was cancelled.")
      : fail("FETCH_FAILED", "The website request failed.")));
    request.end(body);
  });
}

export async function safeFetch(value, options = {}) {
  const { maxBytes = 1024 * 1024, method = "GET", signal: callerSignal, allowHostsForTests, resolveAddresses, requestImpl,
    headers = {}, body, followRedirects = false } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw fail("INVALID_LIMIT", "Invalid response size limit.");
  if (!["GET", "HEAD", "POST"].includes(method) || (method !== "POST" && body !== undefined) ||
      (body !== undefined && typeof body !== "string") || (body !== undefined && Buffer.byteLength(body) > MAX_BYTES))
    throw fail("METHOD_BLOCKED", "Invalid bounded HTTP transport request.");
  if (method === "POST" && followRedirects) throw fail("REDIRECT_BLOCKED", "MCP POST requests never follow redirects or retry.");
  const safeHeaders = validatedHeaders(headers, followRedirects);
  const timeout = AbortSignal.timeout(20_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let next = value;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const target = await assertPublicUrl(next, { allowHostsForTests, resolveAddresses, signal });
    signal.throwIfAborted();
    const result = await pinnedRequest(target, { signal, maxBytes, method, requestImpl, headers: safeHeaders, body });
    if (!followRedirects || ![301, 302, 303, 307, 308].includes(result.status)) return result;
    if (!result.headers.location || redirects === 3) throw fail("REDIRECT_LIMIT", "The website redirect limit was reached.");
    try { next = new URL(result.headers.location, target.url).href; } catch { throw forbidden(); }
    // Every redirect receives independent DNS/address validation before any connection.
  }
}

/**
 * Streaming MCP POST transport. Returns as soon as headers arrive, so an SDK can
 * consume a complete SSE result without waiting for a vendor to close its socket.
 * The body remains byte/time bounded and cancel() destroys the underlying socket.
 */
export async function safeStreamFetch(value, options = {}) {
  const { method = "POST", body, headers = {}, maxBytes = MAX_BYTES, signal: callerSignal,
    allowHostsForTests, resolveAddresses, requestImpl, timeoutMs = 45_000 } = options;
  if (method !== "POST" || options.followRedirects || typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES)
    throw fail("METHOD_BLOCKED", "Streaming MCP transport permits bounded POST requests without redirects only.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000)
    throw fail("INVALID_LIMIT", "Invalid streaming transport limit.");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const safeHeaders = validatedHeaders(headers);
  const target = await assertPublicUrl(value, { allowHostsForTests, resolveAddresses, signal });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let incoming, controller, finished = false, received = 0;
    const endBody = (error) => {
      if (finished) return;
      finished = true;
      if (controller) { if (error) controller.error(error); else controller.close(); }
      else if (error) reject(error);
    };
    const transport = requestImpl ?? (target.url.protocol === "https:" ? https.request : http.request);
    const request = transport(target.url, connectionOptions(target, { method, signal, headers: safeHeaders }), (response) => {
      incoming = response;
      const encoding = response.headers["content-encoding"];
      const length = Number(response.headers["content-length"]);
      if (encoding && encoding !== "identity") {
        endBody(fail("ENCODING_UNSUPPORTED", "The service ignored the bounded uncompressed response request.")); response.destroy(); return;
      }
      if (Number.isFinite(length) && length > maxBytes) {
        endBody(fail("RESPONSE_TOO_LARGE", "The service response exceeds the size limit.")); response.destroy(); return;
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        endBody(fail("REDIRECT_BLOCKED", "MCP transport redirects are not allowed.")); response.destroy(); return;
      }
      if (response.statusCode < 200 || response.statusCode > 599) {
        endBody(fail("FETCH_FAILED", "The service returned an invalid response status.")); response.destroy(); return;
      }
      const empty = [204, 205, 304].includes(response.statusCode);
      const stream = empty ? null : new ReadableStream({
        start(value) { controller = value; },
        pull() { incoming.resume(); },
        cancel() { finished = true; incoming.destroy(); request.destroy(); },
      }, { highWaterMark: 1 });
      response.on("data", (chunk) => {
        if (finished) return;
        received += chunk.length;
        if (received > maxBytes) { endBody(fail("RESPONSE_TOO_LARGE", "The service response exceeds the size limit.")); response.destroy(); return; }
        if (controller) {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize <= 0) response.pause();
        }
      });
      response.on("end", () => endBody());
      response.on("error", () => endBody(fail(signal.aborted ? "FETCH_CANCELLED" : "FETCH_FAILED", signal.aborted ? "The service request timed out or was cancelled." : "The service response was interrupted.")));
      resolve(new Response(stream, { status: response.statusCode, headers: responseHeaders(response) }));
    });
    request.on("error", () => endBody(fail(signal.aborted ? "FETCH_CANCELLED" : "FETCH_FAILED", signal.aborted ? "The service request timed out or was cancelled." : "The service request failed.")));
    request.end(body);
  });
}
