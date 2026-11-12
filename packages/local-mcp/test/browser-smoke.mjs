// Explicit acceptance test. Run only in the optional browser image. No accounts,
// vendor APIs, public pages, messages or model credentials are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { readBrowserPage } from "../src/browser.mjs";

let posts = 0, privateReads = 0;
const server = createServer((request, response) => {
  if (request.method === "POST") { posts++; response.end("unexpected"); return; }
  if (request.url === "/unexpected") { privateReads++; response.end("unexpected"); return; }
  if (request.url === "/redirect") { response.writeHead(302, { location: "/contact" }); response.end(); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Fixture mobile studio</title>
    <h1>Fixture mobile studio</h1><p>We build mobile apps in Poland.</p>
    <a href="mailto:hello@fixture.example">Write to our team</a>
    <a href="/contact">Contact</a><div id="rendered"></div>
    <script>
      document.querySelector('#rendered').textContent = 'Client rendered contact: hello@fixture.example';
      fetch('/unexpected', {method:'POST',body:'must not leave browser'}).catch(() => {});
      fetch('http://169.254.169.254/latest/meta-data').catch(() => {});
      new WebSocket('ws://127.0.0.1:9/no');
    </script>`);
}).listen(0, "127.0.0.1");
await once(server, "listening");
const host = `127.0.0.1:${server.address().port}`;
let sandboxFlagVerified = false;
try {
  await assert.rejects(readBrowserPage(`http://${host}/contact`), { code: "URL_BLOCKED" });
  const result = await readBrowserPage(`http://${host}/redirect`, {
    networkOptions: { allowHostsForTests: [host] },
    onErrorForTests: (error) => console.error(error),
    onBrowserForTests: async () => {
      const commands = await Promise.all((await readdir("/proc")).filter((name) => /^\d+$/.test(name))
        .map((pid) => readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")));
      const command = commands.find((value) => value.includes("--remote-debugging-pipe"));
      assert.ok(command, "An actual Chromium process must be present.");
      const args = command.split("\0");
      assert.equal(args.some((arg) => arg === "--no-sandbox" || arg === "--disable-setuid-sandbox"), false);
      sandboxFlagVerified = true;
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.url, `http://${host}/contact`);
  assert.match(result.text, /Client rendered contact/);
  assert.deepEqual(result.emails, [{ email: "hello@fixture.example", source_url: `http://${host}/contact` }]);
  assert.equal(posts, 0);
  assert.equal(privateReads, 0);
  assert.ok(result.limits.blockedRequests >= 2);
  assert.equal(sandboxFlagVerified, true);
  console.log(JSON.stringify({ test: "real-container-chromium", result: "pass", uid: process.getuid?.(), sandbox: "enabled; no disabling flags", fixtureOnly: true, dynamicText: true, exactEmailSource: true, redirectSource: true, postBlocked: true, metadataBlocked: true }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
