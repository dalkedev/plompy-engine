import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  childEnvironment,
  executable,
  installation,
  privateDirectory,
} from "./runtime.mjs";

const execute = promisify(execFile);

/** Render only: loading a policy is an explicit administrator operation. */
export async function profileForExecutable(value) {
  const browser = await executable(value);
  // AppArmor paths are patterns, including inside quotes. Refuse pattern and
  // variable syntax instead of accidentally granting more than one executable.
  if (!/^[A-Za-z0-9_./ -]+$/.test(browser))
    throw new Error(
      "Use an ASCII browser cache path without AppArmor pattern characters.",
    );
  const name = `szpont-playwright-chromium-${createHash("sha256").update(browser).digest("hex").slice(0, 16)}`;
  return `# Exact pinned Chromium path only. Administrator review/load required.\n# Allows its own sandbox to create user namespaces; not a confinement profile.\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} "${browser}" flags=(unconfined) {\n  userns,\n}\n`;
}

export async function generateProfile(cacheDir) {
  const cache = await privateDirectory(cacheDir);
  const installed = await installation();
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const p=await import(process.argv[1]);process.stdout.write(p.default.chromium.executablePath());",
      pathToFileURL(installed.playwright).href,
    ],
    {
      env: childEnvironment(process.env, cache),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8192,
      windowsHide: true,
      shell: false,
    },
  );
  return profileForExecutable(stdout);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (
    process.platform !== "linux" ||
    process.argv.length !== 4 ||
    process.argv[2] !== "--cache-dir"
  ) {
    console.error(
      "Usage on Linux: node packages/playwright/apparmor-profile.mjs --cache-dir /absolute/private/cache",
    );
    process.exitCode = 1;
  } else
    await generateProfile(process.argv[3])
      .then((profile) => process.stdout.write(profile))
      .catch(() => {
        console.error(
          "Cannot generate the exact Chromium AppArmor profile. Check the pinned browser installation, trusted ownership and a private ASCII cache path without policy pattern characters. No policy or kernel setting was changed.",
        );
        process.exitCode = 1;
      });
}
