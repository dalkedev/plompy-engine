import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executable,
  installation,
  privateDirectory,
} from "../../packages/playwright/runtime.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const launcher = fileURLToPath(
  new URL("../../packages/playwright/launch.mjs", import.meta.url),
);

/** Configuration only: no browser download, account login, model call or service. */
export async function preparePlaywright({
  config,
  publicRoot = sourceRoot,
  browserBin,
  nodeBin = process.execPath,
}) {
  await installation();
  const command = await executable(nodeBin);
  const excluded = [publicRoot, config.workspace];
  const output = await privateDirectory(
    join(config.artifactsDir, "playwright"),
    { create: true, excluded },
  );
  const cache = await privateDirectory(
    join(config.browserDir, "playwright", "cache"),
    { create: true, excluded },
  );
  const args = [launcher, "--output-dir", output, "--browser-cache", cache];
  if (browserBin) args.push("--browser-bin", await executable(browserBin));
  return {
    id: "playwright",
    name: "szpont_playwright",
    server: { command, args },
  };
}
