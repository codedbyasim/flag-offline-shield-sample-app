#!/usr/bin/env node
/**
 * verify-outage.mjs
 * Portable standalone outage resilience verification script bundled with flag-offline-shield.
 *
 * Requires `--src <path>` and `--snapshot <path>`.
 * Verifies:
 *   1. App code AST check (`--src`): fails non-zero if `--src` does not exist, scans 0 files,
 *      or contains ANY Flagsmith SDK init lacking offline defaults (defaultFlags/state/serverState/defaultFlagHandler).
 *   2. Snapshot file is valid non-empty Flagsmith JS state ({ api, flags }).
 *   3. Positive control: against a local mock SDK HTTP server, `flagsmith/isomorphic`
 *      hits `/api/v1/flags/` over HTTP and returns live server values (source: SERVER).
 *   4. Outage check (against http://127.0.0.1:59999/api/v1/ or --outage-url):
 *      - Unprotected client (no defaultFlags) fails with a real network error (NOT XMLHttpRequest)
 *        and reports source: NONE with empty flags.
 *      - Shielded client (with defaultFlags from --snapshot) catches the real network error,
 *        reports source: DEFAULT_FLAGS, and serves every flag's exact baked enabled & value.
 *
 * Explicitly states in output what is NOT covered (`notCovered`).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { scanCodebase } from "./check-drift.mjs";

const NOT_COVERED = [
  "Does not execute your application's own runtime functions, React rendering, or business logic (pair with an app-level outage smoke test).",
  "Does not verify server-side Flagsmith SDKs (Node local evaluation, Python, Go, etc.) or browser localStorage cache persistence.",
  "Does not verify semantic correctness of fallback values or dynamically computed flag keys.",
];

function loadFlagsmithIsomorphic() {
  const candidates = [
    path.join(process.cwd(), "package.json"),
    import.meta.url,
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req("flagsmith/isomorphic");
    } catch {
      // try next resolution root
    }
  }
  console.error(
    "Error: `flagsmith` JS SDK (`flagsmith/isomorphic`) is required by verify-outage.mjs. Install via `npm install flagsmith`."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const srcArg = getArg("--src", null);
const snapshotPath = path.resolve(
  process.cwd(),
  getArg("--snapshot", "./public/flags.json")
);
const outageUrl = getArg(
  "--outage-url",
  process.env.FLAGSMITH_OUTAGE_TEST_URL || "http://127.0.0.1:59999/api/v1/"
);
const envKey = getArg("--env-key", "offline-shield-verify");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatError(err) {
  if (err instanceof Error) {
    const cause = err.cause;
    if (cause instanceof Error && cause.message) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err ?? "");
}

function loadAndValidateSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Snapshot file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    throw new Error(`Snapshot file is empty: ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Snapshot file is not valid JSON (${filePath}): ${err.message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.flags ||
    typeof parsed.flags !== "object" ||
    Array.isArray(parsed.flags)
  ) {
    throw new Error(`Snapshot file has invalid shape (expected { flags: {...} }): ${filePath}`);
  }
  const entries = Object.entries(parsed.flags);
  if (entries.length === 0) {
    throw new Error(`Snapshot contains 0 flags: ${filePath}`);
  }
  return parsed;
}

function buildDefaultFlags(flagsMap) {
  const defaultFlags = {};
  let idx = 1;
  for (const [name, entry] of Object.entries(flagsMap)) {
    defaultFlags[name] = {
      id: typeof entry.id === "number" ? entry.id : idx,
      enabled: Boolean(entry.enabled),
      value: entry.value ?? null,
    };
    idx += 1;
  }
  return defaultFlags;
}

function buildControlPayload(flagsMap) {
  const expected = {};
  const wireFlags = [];
  let id = 1001;
  for (const [name, entry] of Object.entries(flagsMap)) {
    const controlEnabled = !Boolean(entry.enabled);
    const controlValue =
      typeof entry.value === "number"
        ? entry.value + 999
        : `CONTROL_LIVE_${id}`;
    expected[name] = { enabled: controlEnabled, value: controlValue };
    wireFlags.push({
      feature: { id, name, type: "STANDARD" },
      enabled: controlEnabled,
      feature_state_value: controlValue,
    });
    id += 1;
  }
  return { expected, wireFlags };
}

async function run() {
  // 0. Require --src and verify app code has zero unprotected SDK inits
  if (!srcArg) {
    console.error(
      "Error: --src <path> is required so verify-outage.mjs checks your application's SDK initializations."
    );
    process.exit(1);
  }

  const resolvedSrc = path.resolve(process.cwd(), srcArg);
  if (!fs.existsSync(resolvedSrc)) {
    console.error(`Error: --src path does not exist: ${srcArg}`);
    process.exit(1);
  }

  const codeScan = scanCodebase(resolvedSrc);
  if (codeScan.scannedFiles === 0) {
    console.error(`Error: --src path scanned 0 JS/TS source files: ${srcArg}`);
    process.exit(1);
  }

  const appCodeScan = {
    srcPath: path.relative(process.cwd(), resolvedSrc).split(path.sep).join("/") || ".",
    scannedFiles: codeScan.scannedFiles,
    totalInits: codeScan.totalInits,
    unprotectedInits: codeScan.unprotectedInits,
  };

  if (codeScan.totalInits === 0) {
    const failureReport = {
      passed: false,
      reason: `Found 0 Flagsmith SDK inits in ${appCodeScan.srcPath}; verify --src points to your Flagsmith application source.`,
      appCodeScan,
      notCovered: NOT_COVERED,
    };
    console.log(JSON.stringify(failureReport, null, 2));
    console.error(`Error: ${failureReport.reason}`);
    process.exit(1);
  }

  if (codeScan.unprotectedInits.length > 0) {
    const failureReport = {
      passed: false,
      reason: `Found ${codeScan.unprotectedInits.length} Flagsmith SDK init(s) in ${appCodeScan.srcPath} lacking offline defaults.`,
      appCodeScan,
      notCovered: NOT_COVERED,
    };
    console.log(JSON.stringify(failureReport, null, 2));
    console.error(`Error: ${failureReport.reason}`);
    process.exit(1);
  }

  const { createFlagsmithInstance } = loadFlagsmithIsomorphic();
  const snapshot = loadAndValidateSnapshot(snapshotPath);
  const defaultFlags = buildDefaultFlags(snapshot.flags);
  const flagNames = Object.keys(defaultFlags);
  const { expected: controlExpected, wireFlags } = buildControlPayload(snapshot.flags);

  // 1. Positive control: local mock SDK HTTP server
  let mockHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/api/v1/flags")) {
      mockHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(wireFlags));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const mockApiUrl = `http://127.0.0.1:${port}/api/v1/`;

  let controlSummary;
  try {
    const controlClient = createFlagsmithInstance();
    let controlErr = null;
    try {
      await controlClient.init({
        environmentID: envKey,
        api: mockApiUrl,
        defaultFlags,
        enableLogs: false,
        onError: (err) => {
          controlErr = err;
        },
      });
    } catch (err) {
      controlErr = err;
    }

    assert(mockHits === 1, `Positive control expected 1 HTTP request, got ${mockHits}`);
    assert(!controlErr, `Positive control unexpected error: ${formatError(controlErr)}`);
    assert(
      controlClient.loadingState?.source === "SERVER",
      `Positive control expected loadingState.source === "SERVER", got "${controlClient.loadingState?.source}"`
    );

    for (const name of flagNames) {
      const actualEnabled = controlClient.hasFeature(name);
      const actualValue = controlClient.getValue(name);
      assert(
        actualEnabled === controlExpected[name].enabled,
        `Positive control mismatch for ${name}.enabled: expected ${controlExpected[name].enabled}, got ${actualEnabled}`
      );
      assert(
        actualValue === controlExpected[name].value,
        `Positive control mismatch for ${name}.value: expected ${JSON.stringify(
          controlExpected[name].value
        )}, got ${JSON.stringify(actualValue)}`
      );
    }

    controlSummary = {
      passed: true,
      apiUrl: mockApiUrl,
      httpRequests: mockHits,
      sdkSource: controlClient.loadingState.source,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 2. Unprotected outage check (no defaultFlags)
  const unprotectedClient = createFlagsmithInstance();
  let unprotectedErr = null;
  try {
    await unprotectedClient.init({
      environmentID: envKey,
      api: outageUrl,
      enableLogs: false,
      onError: (err) => {
        unprotectedErr = err;
      },
    });
  } catch (err) {
    unprotectedErr = err;
  }

  const unprotectedErrMsg = formatError(
    unprotectedErr ?? unprotectedClient.loadingState?.error
  );
  assert(Boolean(unprotectedErrMsg), "Unprotected outage test expected a network error");
  assert(
    !/XMLHttpRequest/i.test(unprotectedErrMsg),
    `Got XMLHttpRequest error instead of real network error: ${unprotectedErrMsg}`
  );
  assert(
    !/bad port/i.test(unprotectedErrMsg),
    `Got blocked-port error instead of connection error: ${unprotectedErrMsg}`
  );
  assert(
    unprotectedClient.loadingState?.source === "NONE",
    `Unprotected outage expected sdkSource "NONE", got "${unprotectedClient.loadingState?.source}"`
  );
  for (const name of flagNames) {
    assert(
      unprotectedClient.hasFeature(name) === false,
      `Unprotected outage expected ${name} enabled=false`
    );
    assert(
      unprotectedClient.getValue(name) === null,
      `Unprotected outage expected ${name} value=null`
    );
  }

  // 3. Shielded outage check (defaultFlags hydrated from snapshot)
  const shieldedClient = createFlagsmithInstance();
  let shieldedErr = null;
  try {
    await shieldedClient.init({
      environmentID: envKey,
      api: outageUrl,
      defaultFlags,
      enableLogs: false,
      onError: (err) => {
        shieldedErr = err;
      },
    });
  } catch (err) {
    shieldedErr = err;
  }

  const shieldedErrMsg = formatError(
    shieldedErr ?? shieldedClient.loadingState?.error
  );
  assert(Boolean(shieldedErrMsg), "Shielded outage test expected a network error");
  assert(
    !/XMLHttpRequest/i.test(shieldedErrMsg),
    `Got XMLHttpRequest error instead of real network error: ${shieldedErrMsg}`
  );
  assert(
    !/bad port/i.test(shieldedErrMsg),
    `Got blocked-port error instead of connection error: ${shieldedErrMsg}`
  );
  assert(
    shieldedClient.loadingState?.source === "DEFAULT_FLAGS",
    `Shielded outage expected sdkSource "DEFAULT_FLAGS", got "${shieldedClient.loadingState?.source}"`
  );

  for (const name of flagNames) {
    const expected = defaultFlags[name];
    const actualEnabled = shieldedClient.hasFeature(name);
    const actualValue = shieldedClient.getValue(name);
    assert(
      actualEnabled === expected.enabled,
      `Shielded outage mismatch for ${name}.enabled: expected ${expected.enabled}, got ${actualEnabled}`
    );
    assert(
      actualValue === expected.value,
      `Shielded outage mismatch for ${name}.value: expected ${JSON.stringify(
        expected.value
      )}, got ${JSON.stringify(actualValue)}`
    );
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        snapshotPath: path.relative(process.cwd(), snapshotPath).split(path.sep).join("/"),
        flagCount: flagNames.length,
        appCodeScan,
        positiveControl: controlSummary,
        unprotectedOutage: {
          apiUrl: outageUrl,
          sdkSource: unprotectedClient.loadingState.source,
          networkError: unprotectedErrMsg,
          flagsReturned: Object.keys(unprotectedClient.getAllFlags() ?? {}).length,
        },
        shieldedOutage: {
          apiUrl: outageUrl,
          sdkSource: shieldedClient.loadingState.source,
          networkError: shieldedErrMsg,
          flagsVerified: flagNames.length,
        },
        notCovered: NOT_COVERED,
      },
      null,
      2
    )
  );
}

run().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
