import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  childEnvironment,
  executable,
  installation,
  privateDirectory,
} from "./runtime.mjs";

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (
      !["--output-dir", "--browser-cache", "--browser-bin"].includes(flag) ||
      options[flag] !== undefined ||
      !args[index + 1]
    )
      throw new Error(
        "Use only explicit output, cache and optional browser executable paths.",
      );
    options[flag] = args[index + 1];
  }
  if (!options["--output-dir"] || !options["--browser-cache"])
    throw new Error(
      "Private output and browser cache directories are required.",
    );
  return options;
}

export async function launch(args) {
  process.umask(0o077);
  const options = parseArguments(args);
  const installed = await installation();
  const output = await privateDirectory(options["--output-dir"]);
  const cache = await privateDirectory(options["--browser-cache"]);
  // A fresh private cwd also bounds upstream file tools when --ignore-roots is set.
  const session = await mkdtemp(join(output, "session-"));
  // Unix socket paths are short (104 bytes on macOS). Keep ephemeral profiles
  // in a fresh 0700 OS temporary directory rather than a potentially long path.
  const temporaryBase = await realpath(
    process.platform === "win32" ? tmpdir() : "/tmp",
  );
  const temporary = await mkdtemp(join(temporaryBase, "szpw-"));
  await privateDirectory(temporary);
  const env = childEnvironment(process.env, cache, temporary);
  let browser;
  try {
    if (options["--browser-bin"])
      browser = await executable(options["--browser-bin"]);
    else {
      // Resolve with the exact package in a short, credential-free child. Importing
      // Playwright in this wrapper would cache a caller-controlled browser path.
      browser = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const p=await import(process.argv[1]); process.stdout.write(p.default.chromium.executablePath());",
            pathToFileURL(installed.playwright).href,
          ],
          { env, stdio: ["ignore", "pipe", "ignore"], shell: false },
        );
        let value = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Browser lookup timed out."));
        }, 10_000);
        child.stdout.on("data", (chunk) => {
          value += chunk;
          if (value.length > 8192) child.kill("SIGKILL");
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(new Error("Browser lookup failed."));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          code === 0
            ? resolve(value)
            : reject(new Error("Browser lookup failed."));
        });
      });
      browser = await executable(browser);
    }
    const childArgs = [
      installed.cli,
      "--headless",
      "--isolated",
      "--sandbox",
      "--ignore-roots",
      "--no-webmcp",
      "--executable-path",
      browser,
      "--output-dir",
      session,
    ];
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, childArgs, {
        env,
        cwd: session,
        stdio: "inherit",
        shell: false,
      });
      const stop = (signal) => child.kill(signal);
      const term = () => stop("SIGTERM"),
        interrupt = () => stop("SIGINT");
      process.on("SIGTERM", term);
      process.on("SIGINT", interrupt);
      const cleanup = () => {
        process.off("SIGTERM", term);
        process.off("SIGINT", interrupt);
      };
      child.once("error", () => {
        cleanup();
        reject(new Error("Playwright MCP could not start."));
      });
      child.once("exit", (code, signal) => {
        cleanup();
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  } finally {
    // Keep screenshots/results for the operator, remove only this launch's scratch.
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await launch(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "Playwright MCP could not start. Install the pinned tools/browser and check private directory permissions and host sandbox support. No fallback or browser download was attempted.",
      );
      process.exitCode = 1;
    });
}
