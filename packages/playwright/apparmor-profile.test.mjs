import assert from "node:assert/strict";
import {
  chmod,
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
import { test } from "node:test";
import { profileForExecutable } from "./apparmor-profile.mjs";

async function fixture(t) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "szpont-apparmor-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("profile grants userns to one trusted exact path with a deterministic hashed name", async (t) => {
  const root = await fixture(t),
    directory = join(root, "Chromium with spaces");
  await mkdir(directory, { mode: 0o700 });
  const browser = join(directory, "chrome");
  await writeFile(browser, "synthetic-browser-canary", { mode: 0o700 });
  const profile = await profileForExecutable(browser);
  assert.match(
    profile,
    new RegExp(
      `profile szpont-playwright-chromium-[a-f0-9]{16} "${browser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" flags=\\(unconfined\\)`,
    ),
  );
  assert.equal(profile.match(/\buserns,/g).length, 1);
  assert.ok(
    !profile.includes("/**") &&
      !profile.includes("sysctl") &&
      !profile.includes("sudo") &&
      !profile.includes("no-sandbox"),
  );
  assert.equal(await profileForExecutable(browser), profile);
  assert.equal(await readFile(browser, "utf8"), "synthetic-browser-canary");
});

test("profile rejects AppArmor glob, variable and quote syntax instead of broadening a path", async (t) => {
  const root = await fixture(t);
  for (const name of [
    "chrome*",
    "chrome?",
    "chrome[0]",
    "chrome{one,two}",
    'chrome"',
    "chrome\\",
    "chrome@{HOME}",
    "chromé",
  ]) {
    const browser = join(root, name);
    await writeFile(browser, "preserved", { mode: 0o700 });
    await assert.rejects(profileForExecutable(browser), /ASCII|pattern/);
    assert.equal(await readFile(browser, "utf8"), "preserved");
  }
});

test("profile generation preserves executable trust guards and makes no permission repairs", async (t) => {
  const root = await fixture(t),
    browser = join(root, "chrome"),
    alias = join(root, "alias");
  await writeFile(browser, "preserved", { mode: 0o700 });
  await symlink(browser, alias);
  await assert.rejects(profileForExecutable(alias), /cannot modify/);
  await chmod(browser, 0o777);
  await assert.rejects(profileForExecutable(browser), /cannot modify/);
  await assert.rejects(profileForExecutable("relative-chrome"), /absolute/);
  assert.equal(await readFile(browser, "utf8"), "preserved");
});
