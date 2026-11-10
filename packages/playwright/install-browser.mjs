import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  childEnvironment,
  installation,
  privateDirectory,
} from "./runtime.mjs";

export async function installBrowser(cacheDir) {
  const installed = await installation();
  const cache = await privateDirectory(cacheDir, { create: true });
  // Explicit download only. Never install OS packages, invoke sudo, or remove another version.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        installed.playwrightCli,
        "install",
        "chromium",
        "--no-shell",
        "--no-remove",
      ],
      {
        env: childEnvironment(process.env, cache),
        stdio: "inherit",
        shell: false,
      },
    );
    child.once("error", () =>
      reject(new Error("Browser provisioning could not start.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Browser provisioning failed; inspect platform dependencies and network access.",
            ),
          ),
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4 || process.argv[2] !== "--cache-dir") {
    console.error(
      "Usage: node packages/playwright/install-browser.mjs --cache-dir /absolute/private/cache",
    );
    process.exitCode = 1;
  } else {
    process.umask(0o077);
    await installBrowser(process.argv[3]).catch(() => {
      console.error(
        "Pinned browser installation failed. Check private directory permissions, host libraries and network access locally.",
      );
      process.exitCode = 1;
    });
  }
}
