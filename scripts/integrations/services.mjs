import { access, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCredential } from "../../packages/mcp-bridge/src/credential.mjs";
import {
  remoteServiceIds,
  remoteServices,
  serviceDefinition,
} from "../../packages/mcp-bridge/src/services.mjs";

export { remoteServiceIds, remoteServices };
const packageRoot = fileURLToPath(
  new URL("../../packages/mcp-bridge/", import.meta.url),
);
export const bridgeEntry = join(packageRoot, "bridge.mjs");

export async function buildServiceEntry(
  ctx,
  id,
  { auth, credentialFile } = {},
) {
  const config = ctx.config ?? ctx;
  const definition = serviceDefinition(id);
  auth ??= credentialFile ? "api-key" : definition.defaultAuth;
  if (!definition.authModes.includes(auth))
    throw new Error("Unsupported authentication mode for this MCP service.");
  if (auth !== "api-key") {
    if (credentialFile)
      throw new Error(
        "A credential file is accepted only with --auth api-key.",
      );
    return {
      name: `plompy_${id}`,
      server: { url: definition.endpoints[auth] },
    };
  }
  if (!credentialFile)
    throw new Error(
      "API-key mode requires --credential-file pointing to a private token file; never put the token in arguments.",
    );
  const path = await inspectCredential(credentialFile, {
    excluded: [
      config.publicRoot,
      config.workspace,
      config.stateDir,
      config.artifactsDir,
      config.browserDir,
      config.githubConfigDir,
      config.codexHome,
      config.claudeHome,
      config.opencodeHome,
      config.claudeMcpConfig,
      config.opencodeConfig,
    ],
  });
  try {
    const manifest = JSON.parse(
      await readFile(
        join(
          packageRoot,
          "node_modules/@modelcontextprotocol/sdk/package.json",
        ),
        "utf8",
      ),
    );
    if (
      manifest.version !== "1.32.2" ||
      (await lstat(bridgeEntry)).isSymbolicLink()
    )
      throw new Error();
    await access(
      join(
        packageRoot,
        "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
      ),
    );
  } catch {
    throw new Error(
      "Install the optional locked MCP bridge first: npm ci --prefix packages/mcp-bridge",
    );
  }
  return {
    name: `plompy_${id}`,
    server: { command: process.execPath, args: [bridgeEntry, id, path] },
  };
}
