import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { preparePlaywright } from "../../scripts/integrations/playwright.mjs";
import { privateDirectory } from "./runtime.mjs";

const text = (result) =>
  result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
export function failureCategory(value) {
  const message = String(value).slice(0, 65_536);
  if (
    /No usable sandbox|Failed to move to new namespace|userns.*(?:denied|restricted)|apparmor.*(?:denied|userns)|Running as root without --no-sandbox/i.test(
      message,
    )
  )
    return "host-sandbox-unavailable";
  if (
    /error while loading shared libraries|Host system is missing dependencies|Missing libraries/i.test(
      message,
    )
  )
    return "host-libraries-missing";
  if (
    /Executable doesn't exist|browser executable.*(?:missing|not found)|ENOENT/i.test(
      message,
    )
  )
    return "browser-or-path-missing";
  if (/Socket directory path is too long/i.test(message))
    return "socket-path-too-long";
  if (
    /0700|trusted ancestors|cannot modify|unsafe parents|private.*permissions/i.test(
      message,
    )
  )
    return "unsafe-private-path-or-executable";
  if (/timed? ?out|timeout/i.test(message)) return "deadline-exceeded";
  if (/Connection closed|could not start/i.test(message))
    return "mcp-startup-closed";
  return "unexpected-acceptance-failure";
}

export function safeFailure(stage, error, childDiagnostics = "") {
  return {
    status: "FAIL",
    stage,
    category: failureCategory(`${error?.message ?? ""}\n${childDiagnostics}`),
    note: "Synthetic localhost acceptance only; raw page, paths, environment and child output withheld. No sandbox fallback or download was attempted.",
  };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 30_000,
  });
  assert.notEqual(result.isError, true, `${name} failed: ${text(result)}`);
  return result;
}
function reference(snapshot, line) {
  const match = snapshot
    .split("\n")
    .find((item) => item.includes(line))
    ?.match(/\[ref=([^\]]+)\]/);
  assert.ok(match, `Missing observed reference: ${line}`);
  return match[1];
}

/** Real MCP/browser acceptance against only an owned synthetic loopback page. */
export async function smoke(cacheDir) {
  let stage = "prepare-private-paths",
    diagnostics = "";
  process.umask(0o077);
  const scratch = await mkdtemp(
    join(await realpath(tmpdir()), "plompy-playwright-smoke-"),
  );
  const output = join(scratch, "artifacts");
  const browserRoot = join(scratch, "browser");
  const workspace = join(scratch, "workspace");
  for (const directory of [output, browserRoot, workspace])
    await privateDirectory(directory, { create: true });
  const cache = await privateDirectory(cacheDir);
  // The smoke uses the supplied provisioned cache without downloading anything.
  const entry = await preparePlaywright({
    config: { artifactsDir: output, browserDir: browserRoot, workspace },
  });
  entry.server.args[entry.server.args.indexOf("--browser-cache") + 1] = cache;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html><head><title>Owned browser fixture</title></head><body><h1>Browser acceptance</h1><label>Name <input id="name"></label><button id="greet">Greet</button><p role="status" id="result">Waiting</p><script>document.querySelector('#greet').onclick=()=>document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value+'!'</script></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const clients = [];
  try {
    const connect = async () => {
      const client = new Client({
        name: "plompy-owned-browser-smoke",
        version: "1.0.0",
      });
      const transport = new StdioClientTransport({
        ...entry.server,
        stderr: "pipe",
      });
      // Never print a page, inherited environment or unbounded child diagnostics.
      transport.stderr?.on("data", (chunk) => {
        if (diagnostics.length < 16_384)
          diagnostics += chunk
            .toString("utf8")
            .slice(0, 16_384 - diagnostics.length);
      });
      clients.push(client);
      await client.connect(transport, { timeout: 30_000 });
      return client;
    };
    stage = "mcp-initialize";
    const first = await connect();
    stage = "mcp-tools-list";
    const tools = await first.listTools();
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_type",
      "browser_click",
      "browser_take_screenshot",
    ])
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        `Missing ${name}`,
      );
    assert.ok(
      !tools.tools.some((tool) => /install/.test(tool.name)),
      "Runtime installer unexpectedly exposed",
    );
    stage = "browser-navigate";
    await call(first, "browser_navigate", { url });
    stage = "browser-snapshot";
    const snapshot = text(await call(first, "browser_snapshot"));
    stage = "browser-type";
    await call(first, "browser_type", {
      element: "Name textbox",
      target: reference(snapshot, 'textbox "Name"'),
      text: "Playwright",
    });
    stage = "browser-click";
    await call(first, "browser_click", {
      element: "Greet button",
      target: reference(snapshot, 'button "Greet"'),
    });
    stage = "visible-result-assertion";
    assert.match(
      text(
        await call(first, "browser_wait_for", { text: "Hello, Playwright!" }),
      ),
      /Hello, Playwright!/,
    );
    stage = "png-screenshot";
    const screenshot = await call(first, "browser_take_screenshot", {
      type: "png",
    });
    const picture = screenshot.content.find((part) => part.type === "image");
    assert.equal(picture?.mimeType, "image/png");
    assert.deepEqual(
      Buffer.from(picture.data, "base64").subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await call(first, "browser_take_screenshot", {
      type: "png",
      filename: "smoke.png",
    });
    stage = "file-output-boundary";
    const outside = join(scratch, "outside.png");
    const traversal = await first.callTool(
      {
        name: "browser_take_screenshot",
        arguments: { type: "png", filename: outside },
      },
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(
      traversal.isError,
      true,
      "File output escaped its isolated workspace",
    );
    await assert.rejects(lstat(outside), { code: "ENOENT" });
    stage = "file-navigation-boundary";
    const canary = join(scratch, "private-canary.html");
    await writeFile(canary, "<!doctype html><h1>private-file-canary</h1>", {
      mode: 0o600,
    });
    const fileNavigation = await first.callTool(
      {
        name: "browser_navigate",
        arguments: { url: pathToFileURL(canary).href },
      },
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(
      fileNavigation.isError,
      true,
      "Local file navigation was unexpectedly allowed",
    );
    assert.ok(!text(fileNavigation).includes("<h1>private-file-canary</h1>"));
    stage = "concurrent-context-isolation";
    await call(first, "browser_evaluate", {
      function:
        "() => { localStorage.setItem('owned-smoke', 'first-session'); return localStorage.getItem('owned-smoke'); }",
    });
    const second = await connect();
    await call(second, "browser_navigate", { url });
    assert.match(
      text(
        await call(second, "browser_evaluate", {
          function: "() => localStorage.getItem('owned-smoke')",
        }),
      ),
      /null/,
    );
    stage = "artifact-permissions-and-content";
    const sessions = await readdir(join(output, "playwright"));
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.equal(
        (await lstat(join(output, "playwright", session))).mode & 0o777,
        0o700,
      );
    }
    const saved = await Promise.all(
      sessions.map(async (session) => {
        try {
          return {
            bytes: await readFile(
              join(output, "playwright", session, "smoke.png"),
            ),
            info: await lstat(join(output, "playwright", session, "smoke.png")),
          };
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      }),
    );
    const found = saved.find(Boolean);
    assert.ok(found);
    assert.equal(found.info.mode & 0o077, 0);
    assert.equal(
      found.bytes.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    return {
      status: "PASS",
      mcpVersion: "0.0.85",
      checks: [
        "real stdio MCP",
        "owned localhost navigation",
        "observed snapshot references",
        "type and click",
        "visible result assertion",
        "PNG screenshot and private output",
        "file output traversal refused",
        "local file navigation refused",
        "concurrent isolated contexts",
        "no runtime install tool",
      ],
    };
  } catch (error) {
    const failure = new Error("Synthetic browser acceptance failed.");
    failure.diagnostic = safeFailure(stage, error, diagnostics);
    throw failure;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const cache =
    process.argv.length === 2
      ? process.env.PLOMPY_PLAYWRIGHT_SMOKE_CACHE
      : process.argv.length === 4 && process.argv[2] === "--cache-dir"
        ? process.argv[3]
        : undefined;
  if (!cache) {
    console.error(
      "Usage: node packages/playwright/smoke.mjs --cache-dir /absolute/private/cache",
    );
    process.exitCode = 1;
  } else
    await smoke(cache)
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(
          JSON.stringify(
            error.diagnostic ?? safeFailure("prepare-private-paths", error),
          ),
        );
        process.exitCode = 1;
      });
}
