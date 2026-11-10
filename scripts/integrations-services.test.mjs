import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServiceEntry,
  remoteServiceIds,
  remoteServices,
} from "./integrations/services.mjs";
import {
  inspectCredential,
  readCredential,
} from "../packages/mcp-bridge/src/credential.mjs";

const secret = "SYNTHETIC-mcp-private-token-only";
async function fixture(t) {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "szpont-service-auth-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {};
  for (const key of [
    "publicRoot",
    "workspace",
    "stateDir",
    "artifactsDir",
    "browserDir",
    "githubConfigDir",
    "codexHome",
    "claudeHome",
    "opencodeHome",
  ]) {
    config[key] = join(dir, key);
    await mkdir(config[key], { mode: 0o700 });
  }
  const credentials = join(dir, "credentials");
  await mkdir(credentials, { mode: 0o700 });
  const path = join(credentials, "service-token.txt");
  await writeFile(path, secret + "\n", { mode: 0o600 });
  return { dir, config, path, credentials };
}

test("fixed services default to native OAuth without opening key files or installing an SDK", async () => {
  assert.deepEqual(remoteServiceIds, [
    "perplexity",
    "firecrawl",
    "tinyfish",
    "posthog",
  ]);
  for (const id of remoteServiceIds)
    assert.deepEqual(await buildServiceEntry({}, id), {
      name: `szpont_${id}`,
      server: { url: remoteServices[id].endpoints.oauth },
    });
  assert.equal(
    remoteServices.firecrawl.endpoints.oauth,
    "https://mcp.firecrawl.dev/v2/mcp-oauth",
  );
  assert.equal(
    remoteServices.posthog.endpoints.oauth,
    "https://mcp.posthog.com/mcp?readonly=true",
  );
  assert.deepEqual(
    await buildServiceEntry({}, "firecrawl", { auth: "keyless" }),
    {
      name: "szpont_firecrawl",
      server: { url: "https://mcp.firecrawl.dev/v2/mcp" },
    },
  );
  await assert.rejects(buildServiceEntry({}, "tinyfish", { auth: "keyless" }));
  await assert.rejects(buildServiceEntry({}, "__proto__"));
});

test("API mode requires a file and a file cannot be supplied to native OAuth/keyless", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildServiceEntry(f, "perplexity", { auth: "api-key" }),
    /--credential-file/,
  );
  for (const auth of ["oauth", "keyless"])
    await assert.rejects(
      buildServiceEntry(f, "firecrawl", { auth, credentialFile: f.path }),
      /only with --auth api-key/,
    );
});

test("key file reference is the only credential material in managed runner entries", async (t) => {
  const f = await fixture(t);
  for (const id of remoteServiceIds) {
    try {
      const entry = await buildServiceEntry(f, id, { credentialFile: f.path });
      assert.equal(entry.name, `szpont_${id}`);
      assert.equal(entry.server.command, process.execPath);
      assert.deepEqual(entry.server.args.slice(1), [id, f.path]);
      assert.equal(Object.hasOwn(entry.server, "env"), false);
      assert.equal(JSON.stringify(entry).includes(secret), false);
    } catch (error) {
      // Root's mandatory offline suite works without optional tooling installed.
      assert.match(
        error.message,
        /^Install the optional locked MCP bridge first: npm ci --prefix packages\/mcp-bridge$/,
      );
    }
  }
  assert.equal(await readFile(f.path, "utf8"), secret + "\n");
});

test("credential files cannot overlap public, workspace, state, browser or runner data", async (t) => {
  const f = await fixture(t);
  for (const directory of Object.values(f.config)) {
    const path = join(directory, "token.txt");
    await writeFile(path, secret, { mode: 0o600 });
    await assert.rejects(
      buildServiceEntry(f, "perplexity", { credentialFile: path }),
      /separate owner-only credential file/,
    );
    assert.equal(await readFile(path, "utf8"), secret);
  }
});

test("credential helper accepts bounded printable token plus one final newline and never modifies it", async (t) => {
  const f = await fixture(t);
  for (const suffix of ["", "\n", "\r\n"]) {
    await writeFile(f.path, secret + suffix);
    assert.deepEqual(await readCredential(f.path), {
      path: f.path,
      token: secret,
    });
    assert.equal(await inspectCredential(f.path), f.path);
    assert.equal(await readFile(f.path, "utf8"), secret + suffix);
  }
});

test("credential helper rejects symlinks, ancestor aliases, hardlinks, unsafe permissions and malformed tokens without echoing them", async (t) => {
  const f = await fixture(t);
  const alias = join(f.credentials, "alias.txt");
  await symlink(f.path, alias);
  const parentAlias = join(f.dir, "alias-dir");
  await symlink(f.credentials, parentAlias);
  for (const path of [
    alias,
    join(parentAlias, "service-token.txt"),
    "relative.txt",
  ])
    await assert.rejects(readCredential(path));
  const hard = join(f.credentials, "hard.txt");
  await link(f.path, hard);
  await assert.rejects(readCredential(f.path));
  await rm(hard);
  await chmod(f.path, 0o644);
  await assert.rejects(readCredential(f.path));
  await chmod(f.path, 0o600);
  await chmod(f.credentials, 0o755);
  await assert.rejects(readCredential(f.path));
  await chmod(f.credentials, 0o700);
  for (const value of [
    "",
    secret + "\n\n",
    secret + "\r",
    secret + "\0",
    "Bearer " + secret,
    " " + secret,
    "x".repeat(4097),
    Buffer.from([0xc3, 0x28]),
  ]) {
    await writeFile(f.path, value);
    await assert.rejects(readCredential(f.path), (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(f.path), false);
      return true;
    });
  }
});
