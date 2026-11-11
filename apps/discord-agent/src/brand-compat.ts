import { lstatSync } from "node:fs";
import { resolve } from "node:path";

// Compatibility is read-only: explicit PLOMPY_* values always win, including
// empty values (which normal configuration validation will reject).
export function normalizeEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("SZPONT_")) {
      const replacement = `PLOMPY_${key.slice(7)}`;
      if (env[replacement] === undefined) env[replacement] = value;
    }
  }
  return env;
}

export function compatiblePath(current: string, legacy: string) {
  const present = (path: string) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const hasCurrent = present(current), hasLegacy = present(legacy);
  if (hasCurrent && hasLegacy)
    throw new Error("Both current and legacy paths exist; select one explicitly in the private environment.");
  return hasLegacy ? legacy : current;
}

export const managedMcpPath = (home: string) => compatiblePath(
  resolve(home, "plompy-mcp.json"), resolve(home, "szpont-mcp.json"),
);
export const defaultBrowserPath = () => compatiblePath(
  "/var/lib/plompy/browser", "/var/lib/szpont/browser",
);
