import { DatabaseSync } from "node:sqlite";

type RuntimeCheck = {
  status: "PASS" | "FAIL" | "NOT_RUN";
  message: string;
};
export type RuntimeInspection = { node: RuntimeCheck; sqlite: RuntimeCheck };
export type RuntimeOptions = {
  nodeVersion?: string;
  sqliteVersion?: string;
  querySQLiteVersion?: () => unknown;
};

function version(value: unknown): number[] | undefined {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return;
  const parts = value.split(".").map(Number);
  if (parts.every(Number.isSafeInteger)) return parts;
}

function patchedSQLite(value: unknown): boolean {
  const parts = version(value);
  if (!parts) return false;
  const [major = 0, minor = 0] = parts;
  return major > 3 || (major === 3 && minor >= 54);
}

function querySQLiteVersion(): unknown {
  // Only an in-memory database is opened here. No untrusted DB or WAL is read.
  const db = new DatabaseSync(":memory:");
  try {
    return db.prepare("SELECT sqlite_version() AS version").get()?.version;
  } finally {
    db.close();
  }
}

/** Inspect the actual linked runtime before opening any filesystem database. */
export function inspectRuntime(
  options: RuntimeOptions = {},
): RuntimeInspection {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const parts = version(nodeVersion);
  const nodeSupported = parts?.[0] === 26 && (parts[1] ?? 0) >= 13;
  const node: RuntimeCheck = {
    status: nodeSupported ? "PASS" : "FAIL",
    message: nodeSupported
      ? "Node 26.13.0 or newer within Node 26 is available."
      : "Use stable Node 26.13.0 or newer within Node 26; other runtime versions are unsupported.",
  };
  if (!nodeSupported)
    return {
      node,
      sqlite: {
        status: "NOT_RUN",
        message:
          "The supported Node runtime must pass before the in-memory SQLite check; no database was opened.",
      },
    };
  const sqliteVersion = options.sqliteVersion ?? process.versions.sqlite;
  if (!patchedSQLite(sqliteVersion))
    return {
      node,
      sqlite: {
        status: "FAIL",
        message:
          "Runtime metadata must identify SQLite 3.54.0 or newer; the in-memory query was not run.",
      },
    };
  try {
    const linkedVersion = (options.querySQLiteVersion ?? querySQLiteVersion)();
    if (!patchedSQLite(linkedVersion) || linkedVersion !== sqliteVersion)
      return {
        node,
        sqlite: {
          status: "FAIL",
          message:
            "The in-memory SQLite version must match runtime metadata and be at least 3.54.0.",
        },
      };
    return {
      node,
      sqlite: {
        status: "PASS",
        message:
          "SQLite 3.54.0 or newer is confirmed by runtime metadata and an in-memory SQL query; no filesystem database was opened.",
      },
    };
  } catch {
    return {
      node,
      sqlite: {
        status: "FAIL",
        message:
          "The linked SQLite version could not be verified with an in-memory SQL query.",
      },
    };
  }
}

export function assertSupportedRuntime(): void {
  const result = inspectRuntime();
  if (result.node.status !== "PASS" || result.sqlite.status !== "PASS") {
    throw new Error(
      result.node.status !== "PASS"
        ? "unsupported_node_runtime"
        : "unsupported_sqlite_runtime",
    );
  }
}
