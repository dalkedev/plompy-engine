import { readCredential } from "./src/credential.mjs";
import { serviceDefinition } from "./src/services.mjs";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    !/^26\.(?:1[3-9]|[2-9]\d|\d{3,})\.\d+$/.test(process.versions.node)
  )
    throw new Error();
  const [serviceId, credentialFile] = args;
  serviceDefinition(serviceId);
  const { token } = await readCredential(credentialFile);
  // Optional SDK imports happen only when an API-key server is actually launched.
  const { createBridge } = await import("./src/bridge.mjs");
  const bridge = await createBridge({ serviceId, token });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      bridge.close().finally(() => {
        process.exitCode = 0;
      });
    });
} catch {
  process.stderr.write(
    "Managed MCP bridge could not start. Check the private credential file and install its locked dependencies; remote authentication or connectivity may also have failed. No request was retried.\n",
  );
  process.exitCode = 1;
}
