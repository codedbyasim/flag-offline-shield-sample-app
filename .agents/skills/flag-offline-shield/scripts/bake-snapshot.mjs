#!/usr/bin/env node
/**
 * bake-snapshot.mjs
 * Portable Flagsmith offline snapshot baker for client-side JS/React apps.
 *
 * Runs `flagsmith eval --js` (using --sdk-api-url when FLAGSMITH_SDK_API_URL is set),
 * validates stdout strictly (guarding against @flagsmith/cli v2.0.0 exit-0 failures),
 * and atomically writes the validated snapshot so an existing snapshot is never corrupted.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const outPath = path.resolve(process.cwd(), getArg("--out", "./public/flags.json"));

function buildEnv() {
  const env = { ...process.env };
  const envFile = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key.startsWith("FLAGSMITH_") && !env[key] && val) {
        env[key] = val;
      }
    }
  }
  return env;
}

function quoteWinArg(arg) {
  if (/[\s|&<>^"%!]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function runFlagsmith(cliArgs, env) {
  if (process.platform === "win32") {
    const cmdLine = ["flagsmith", ...cliArgs.map(quoteWinArg)].join(" ");
    return spawnSync(cmdLine, {
      encoding: "utf8",
      env,
      shell: true,
      timeout: 15000,
    });
  }
  return spawnSync("flagsmith", cliArgs, {
    encoding: "utf8",
    env,
    timeout: 15000,
  });
}

function main() {
  const env = buildEnv();
  const cliArgs = ["eval", "--js"];
  if (env.FLAGSMITH_SDK_API_URL) {
    cliArgs.push("--sdk-api-url", env.FLAGSMITH_SDK_API_URL);
  }

  const result = runFlagsmith(cliArgs, env);
  if (result.error) {
    throw new Error(`Failed to execute flagsmith CLI: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.status !== 0) {
    const details = [stderr, stdout].filter(Boolean).join(" | ");
    throw new Error(
      `flagsmith eval --js exited with code ${result.status}${details ? `: ${details}` : ""}`
    );
  }

  if (!stdout) {
    throw new Error(
      `flagsmith eval --js returned empty stdout.${stderr ? ` stderr: ${stderr}` : ""}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `flagsmith eval --js returned non-JSON output: ${stdout.slice(0, 300)}${
        stderr ? ` | stderr: ${stderr}` : ""
      } (${err.message})`
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.flags ||
    typeof parsed.flags !== "object" ||
    Array.isArray(parsed.flags)
  ) {
    throw new Error(
      `flagsmith eval --js returned invalid snapshot shape (expected { api, flags: {...} }): ${stdout.slice(
        0,
        300
      )}`
    );
  }

  const flagNames = Object.keys(parsed.flags);
  if (flagNames.length === 0) {
    throw new Error(
      "flagsmith eval --js returned 0 flags; refusing to overwrite offline snapshot with an empty flags map."
    );
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, outPath);

  console.log(
    JSON.stringify(
      {
        ok: true,
        snapshotPath: path.relative(process.cwd(), outPath).split(path.sep).join("/"),
        api: parsed.api ?? null,
        flagCount: flagNames.length,
        flags: flagNames,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
