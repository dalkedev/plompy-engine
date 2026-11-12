// Explicit fixture-only entry point, excluded from production image build.
import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const fixturePort = 18881;
const fixture = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.method !== "GET") { response.writeHead(405); response.end("No writes in fixtures."); return; }
  if (request.url.startsWith("/search?")) {
    response.end(`<!doctype html><title>Synthetic search results</title><h1>Mobile application studios in Poland</h1>
      <a href="/companies/aurora">Fixture Aurora, mobile apps, Poland</a>
      <a href="/companies/aurora-copy">Duplicate Aurora listing</a>
      <a href="/companies/cedar">Fixture Cedar, mobile apps, Poland</a>`);
    return;
  }
  const cedar = request.url === "/companies/cedar";
  if (!cedar && !["/companies/aurora", "/companies/aurora-copy"].includes(request.url)) {
    response.writeHead(404); response.end("Missing synthetic page."); return;
  }
  const name = cedar ? "=Fixture Cedar" : "Fixture Aurora";
  const email = cedar ? "hello@cedar.fixture.example" : "hello@aurora.fixture.example";
  response.end(`<!doctype html><title>${name}</title><h1>${name}</h1>
    <p>We develop mobile applications for companies in Poland.</p><div id="contact"></div>
    <script>document.querySelector('#contact').textContent='Public business contact: ${email}';</script>
    <a href="mailto:${email}">Contact our team</a>`);
}).listen(fixturePort, "127.0.0.1");
await once(fixture, "listening");
const config = await loadConfig();
config.server.port = 17331;
config.server.allowedHosts = ["127.0.0.1:17331", "localhost:17331"];
config.integrations = { web: { enabled: true }, playwright: { enabled: true } };
const server = await startServer(config, {
  port: 7331,
  toolOptions: { networkOptions: { allowHostsForTests: [`127.0.0.1:${fixturePort}`] } },
});
console.log("Synthetic research fixture ready. No external providers or model account.");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve));
});
