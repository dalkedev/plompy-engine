import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { integrationInstructions } from "../dist/workspace.js";
import { playbook } from "../../../scripts/integrations/catalog.mjs";

test("each runner receives its own integration instructions without losing the first tools", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "szpont-integration-prompt-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "agent"));
  const entries = ["codex", "claude", "opencode"].flatMap((provider) => [
    { id: "github", name: "github", provider },
    { id: "camoufox", name: "szpont_browser", provider },
    { id: "context7", name: "szpont_context7", provider },
    { id: "openai-docs", name: "szpont_openai_docs", provider },
  ]);
  const all = playbook(entries);
  assert.ok(all.length > 5000);
  await writeFile(join(workspace, "agent", "INTEGRATIONS.md"), all);
  for (const provider of ["codex", "claude", "opencode"]) {
    const text = await integrationInstructions({ workspace }, provider);
    assert.match(text, /not authorization/);
    assert.match(text, /Never copy credentials/);
    assert.match(text, new RegExp(`## GitHub \\(${provider}\\)`));
    assert.match(text, new RegExp(`## szpont_browser \\(${provider}\\)`));
    for (const other of ["codex", "claude", "opencode"].filter(
      (p) => p !== provider,
    ))
      assert.ok(!text.includes(`(${other})`));
  }
});

test("missing integration instructions preserve existing workspaces", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "szpont-integration-empty-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  assert.equal(await integrationInstructions({ workspace }, "codex"), "");
});
