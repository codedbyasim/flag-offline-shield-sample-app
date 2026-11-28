#!/usr/bin/env node
/**
 * check-drift.mjs
 * Low-token Flagsmith offline snapshot drift detector + TypeScript AST fallback & init scanner.
 *
 * Outputs compact JSON: summary + ONLY problem rows (drift, unprotectedInits,
 * unprotectedCalls, uncoveredFlags, unknownFlags, unverified), with zero duplicated arrays.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function loadTypeScript() {
  const candidates = [
    path.join(process.cwd(), "package.json"),
    import.meta.url,
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      return req("typescript");
    } catch {
      // try next resolution root
    }
  }
  console.error(
    "Error: TypeScript compiler API (`typescript`) is required by check-drift.mjs. Install via `npm install -D typescript`."
  );
  process.exit(1);
}

const ts = loadTypeScript();

const args = process.argv.slice(2);
const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const srcDir = getArg("--src", "./src");
const snapshotPath = getArg("--snapshot", "./public/flags.json");
const liveFilePath = getArg("--live-file", null);
const failOnFindings = args.includes("--fail-on-findings");
const verboseOutput = args.includes("--verbose") || args.includes("--pretty");
const jqExpr = "[.[] | {name: .feature, enabled, value}]";

const FLAGSMITH_MODULE_RE = /^(@flagsmith\/)?flagsmith(\/|$)|^flagsmith-nodejs$/;
const FLAGSMITH_TYPE_NAMES = new Set(["IFlagsmith", "Flagsmith"]);
const BOOLEAN_FLAG_METHODS = new Set(["hasFeature", "isFeatureEnabled"]);
const VALUE_FLAG_METHODS = new Set(["getValue", "getFeatureValue"]);
const FLAG_READ_METHODS = new Set([
  ...BOOLEAN_FLAG_METHODS,
  ...VALUE_FLAG_METHODS,
]);
const RUNTIME_CLIENT_IMPORT_NAMES = new Set([
  "createFlagsmithInstance",
  "useFlagsmith",
  "Flagsmith",
  "FlagsmithProvider",
  "useFlags",
  "default",
]);
const OFFLINE_DEFAULT_KEYS = [
  "defaultFlags",
  "state",
  "serverState",
  "defaultFlagHandler",
  "default_flag_handler",
  "offlineHandler",
];
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

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

function parseValidatedFlagArray(rawStdout, stderrText, sourceLabel) {
  const trimmed = (rawStdout ?? "").trim();
  const stderr = (stderrText ?? "").trim();

  if (!trimmed) {
    throw new Error(
      `${sourceLabel} returned empty stdout.${stderr ? ` stderr: ${stderr}` : ""}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `${sourceLabel} returned non-JSON output: ${trimmed.slice(0, 300)}${
        stderr ? ` | stderr: ${stderr}` : ""
      } (${err.message})`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `${sourceLabel} returned non-array JSON (${typeof parsed}): ${trimmed.slice(0, 300)}`
    );
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.name !== "string" ||
      typeof item.enabled !== "boolean"
    ) {
      throw new Error(
        `${sourceLabel} item[${i}] has invalid shape (expected {name: string, enabled: boolean, value}): ${JSON.stringify(
          item
        )}`
      );
    }
  }

  return parsed;
}

function loadLiveFlags() {
  if (liveFilePath) {
    let raw;
    try {
      raw = fs.readFileSync(liveFilePath, "utf8");
    } catch (err) {
      throw new Error(`Failed to read live fixture ${liveFilePath}: ${err.message}`);
    }
    const flags = parseValidatedFlagArray(raw, "", `Live fixture (${liveFilePath})`);
    return { source: "fixture", flags };
  }

  const env = buildEnv();
  const cliArgs = ["flag", "list"];
  if (env.FLAGSMITH_API_URL) {
    cliArgs.push("--api-url", env.FLAGSMITH_API_URL);
  }
  cliArgs.push("--json", "--jq", jqExpr);

  const result = runFlagsmith(cliArgs, env);
  if (result.error) {
    throw new Error(`Failed to execute flagsmith CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(
      `flagsmith flag list exited with code ${result.status}${details ? `: ${details}` : ""}`
    );
  }

  const flags = parseValidatedFlagArray(
    result.stdout,
    result.stderr,
    "flagsmith flag list"
  );
  return { source: "cli", flags };
}

function loadSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeValue(val) {
  return val === undefined ? null : val;
}

function toPosixRelative(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

function getScriptKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function collectSourceFiles(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return SOURCE_EXT_RE.test(targetPath) ? [targetPath] : [];
  }

  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (SOURCE_EXT_RE.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  walk(targetPath);
  return files.sort();
}

function unwrapExpr(node) {
  let curr = node;
  while (curr) {
    if (
      ts.isParenthesizedExpression(curr) ||
      ts.isAsExpression(curr) ||
      ts.isTypeAssertionExpression(curr) ||
      ts.isNonNullExpression(curr) ||
      ts.isSatisfiesExpression(curr)
    ) {
      curr = curr.expression;
    } else {
      break;
    }
  }
  return curr;
}

function getPropertyNameText(nameNode) {
  if (!nameNode) return null;
  if (
    ts.isIdentifier(nameNode) ||
    ts.isPrivateIdentifier(nameNode) ||
    ts.isStringLiteral(nameNode) ||
    ts.isNumericLiteral(nameNode)
  ) {
    return nameNode.text;
  }
  return null;
}

function getStringLiteralValue(node) {
  if (!node) return null;
  const unwrapped = unwrapExpr(node);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return null;
}

function getTypeName(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode)) {
    if (ts.isIdentifier(typeNode.typeName)) {
      return typeNode.typeName.text;
    }
    if (ts.isQualifiedName(typeNode.typeName)) {
      return typeNode.typeName.right.text;
    }
  }
  if (ts.isUnionTypeNode(typeNode)) {
    for (const part of typeNode.types) {
      const name = getTypeName(part);
      if (name) return name;
    }
  }
  return null;
}

function isNullishOrFalseExpr(expr) {
  if (!expr) return true;
  const unwrapped = unwrapExpr(expr);
  if (
    unwrapped.kind === ts.SyntaxKind.UndefinedKeyword ||
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    return true;
  }
  return false;
}

function readJsonFileCached(absPath, cache) {
  const norm = path.resolve(absPath);
  if (cache && cache.has(norm)) return cache.get(norm);
  let entry = { ok: false, data: null };
  try {
    if (fs.existsSync(norm)) {
      entry = { ok: true, data: JSON.parse(fs.readFileSync(norm, "utf8")) };
    }
  } catch {
    entry = { ok: false, data: null };
  }
  if (cache) cache.set(norm, entry);
  return entry;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function isIdentifierEnclosingParam(idNode) {
  if (!idNode || !ts.isIdentifier(idNode)) return false;
  const name = idNode.text;
  let curr = idNode.parent;
  while (curr) {
    if (
      ts.isFunctionDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isArrowFunction(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isConstructorDeclaration(curr)
    ) {
      for (const param of curr.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === name) {
          return true;
        }
        if (ts.isObjectBindingPattern(param.name)) {
          for (const el of param.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) {
              return true;
            }
          }
        }
      }
    }
    curr = curr.parent;
  }
  return false;
}

function resolveJsonValue(expr, ctx, visited = new Set()) {
  if (!expr) return { resolved: false };
  const unwrapped = unwrapExpr(expr);

  if (
    ts.isPropertyAccessExpression(unwrapped) ||
    ts.isElementAccessExpression(unwrapped)
  ) {
    const base = resolveJsonValue(unwrapped.expression, ctx, visited);
    if (!base.resolved || !isPlainObject(base.value)) {
      return { resolved: false };
    }
    const key = ts.isPropertyAccessExpression(unwrapped)
      ? getPropertyNameText(unwrapped.name)
      : getStringLiteralValue(unwrapped.argumentExpression);
    if (key === null) return { resolved: false };
    return { resolved: true, value: base.value[key] };
  }

  if (ts.isIdentifier(unwrapped)) {
    const name = unwrapped.text;
    if (ctx.paramBindings?.has(name) && !visited.has(`param:${name}`)) {
      const bound = ctx.paramBindings.get(name);
      return resolveJsonValue(
        bound.expr,
        bound.ctx,
        new Set([...visited, `param:${name}`])
      );
    }
    if (ctx.jsonImportPaths?.has(name)) {
      const info = ctx.jsonImportPaths.get(name);
      const parsed = readJsonFileCached(info.filePath, ctx.jsonCache);
      if (!parsed.ok) return { resolved: false };
      const val = info.propName ? parsed.data?.[info.propName] : parsed.data;
      return { resolved: true, value: val };
    }
    if (ctx.localConstBindings?.has(name) && !visited.has(`const:${name}`)) {
      return resolveJsonValue(
        ctx.localConstBindings.get(name),
        ctx,
        new Set([...visited, `const:${name}`])
      );
    }
    if (
      ctx.importedProjectSymbols?.has(name) &&
      !visited.has(`imp:${name}`) &&
      ctx.projectIndex
    ) {
      const sym = ctx.importedProjectSymbols.get(name);
      const exp = ctx.projectIndex.exportedValuesByFile
        .get(sym.targetFilePath)
        ?.get(sym.exportName);
      const targetCtx = ctx.projectIndex.fileContextByPath.get(sym.targetFilePath);
      if (exp && targetCtx) {
        return resolveJsonValue(
          exp.expr,
          { ...targetCtx, jsonCache: ctx.jsonCache, projectIndex: ctx.projectIndex },
          new Set([...visited, `imp:${name}`])
        );
      }
    }
  }

  return { resolved: false };
}

function resolveObjectProperties(expr, ctxOrBindings, visited = new Set()) {
  if (!expr) return { resolved: false, expr: null };
  const isCtx = ctxOrBindings && typeof ctxOrBindings.get !== "function";
  const localConstBindings = isCtx
    ? ctxOrBindings.localConstBindings
    : ctxOrBindings;
  const ctx = isCtx ? ctxOrBindings : { localConstBindings };
  const unwrapped = unwrapExpr(expr);

  if (ts.isIdentifier(unwrapped)) {
    const name = unwrapped.text;
    if (ctx.paramBindings?.has(name) && !visited.has(`param:${name}`)) {
      const bound = ctx.paramBindings.get(name);
      return resolveObjectProperties(
        bound.expr,
        bound.ctx,
        new Set([...visited, `param:${name}`])
      );
    }
    if (
      ctx.importedProjectSymbols?.has(name) &&
      !visited.has(`imp:${name}`) &&
      ctx.projectIndex
    ) {
      const sym = ctx.importedProjectSymbols.get(name);
      const exp = ctx.projectIndex.exportedValuesByFile
        .get(sym.targetFilePath)
        ?.get(sym.exportName);
      const targetCtx = ctx.projectIndex.fileContextByPath.get(sym.targetFilePath);
      if (exp && targetCtx) {
        return resolveObjectProperties(
          exp.expr,
          { ...targetCtx, jsonCache: ctx.jsonCache, projectIndex: ctx.projectIndex },
          new Set([...visited, `imp:${name}`])
        );
      }
    }
    if (!visited.has(name) && localConstBindings?.has(name)) {
      return resolveObjectProperties(
        localConstBindings.get(name),
        ctx,
        new Set([...visited, name])
      );
    }
    return { resolved: false, expr: unwrapped };
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    const props = new Map();
    let hasUnresolvedSpread = false;
    let hasComputedProp = false;

    for (const prop of unwrapped.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const sub = resolveObjectProperties(
          prop.expression,
          ctx,
          new Set(visited)
        );
        if (sub.resolved) {
          for (const [k, v] of sub.props.entries()) {
            props.set(k, v);
          }
          if (sub.hasUnresolvedSpread) hasUnresolvedSpread = true;
          if (sub.hasComputedProp) hasComputedProp = true;
        } else {
          hasUnresolvedSpread = true;
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        props.set(prop.name.text, { expr: prop.name, node: prop });
      } else if (ts.isPropertyAssignment(prop)) {
        const key = getPropertyNameText(prop.name);
        if (key !== null) {
          props.set(key, { expr: prop.initializer, node: prop });
        } else {
          hasComputedProp = true;
        }
      }
    }

    return { resolved: true, props, hasUnresolvedSpread, hasComputedProp };
  }

  return { resolved: false, expr: unwrapped };
}

function combineOutcomes(outcomes, fallbackEmptyStatus = "empty_defaults") {
  if (outcomes.length === 0) return { status: fallbackEmptyStatus };
  const unverified = outcomes.find((o) => o.status === "unverified");
  if (unverified) return unverified;
  const missing = outcomes.find((o) => o.status === "missing_defaults");
  if (missing) return missing;
  const empty = outcomes.find((o) => o.status === "empty_defaults");
  if (empty) return empty;

  const keys = new Set();
  let allLiteral = true;
  for (const o of outcomes) {
    if (o.kind === "literal" && o.keys) {
      for (const k of o.keys) keys.add(k);
    } else {
      allLiteral = false;
    }
  }
  return allLiteral
    ? { status: "ok", kind: "literal", keys }
    : { status: "ok", kind: "dynamic" };
}

function getObjectIterationSource(forStmt) {
  const expr = unwrapExpr(forStmt.expression);
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    (expr.expression.name.text === "entries" ||
      expr.expression.name.text === "keys") &&
    expr.arguments.length >= 1
  ) {
    return expr.arguments[0];
  }
  if (ts.isForInStatement(forStmt)) {
    return expr;
  }
  return null;
}

function traceLocalObjectPopulation(varName, scopeNode, ctx, callDepth = 0) {
  if (!scopeNode) return { status: "empty_defaults" };
  const literalKeys = new Set();
  const sourceOutcomes = [];
  let untraceableMutation = false;

  const visitScope = (n, enclosingLoopSrc) => {
    if (untraceableMutation) return;
    if (
      n !== scopeNode &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n))
    ) {
      return;
    }

    let nextLoopSrc = enclosingLoopSrc;
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const iterSrc = getObjectIterationSource(n);
      if (iterSrc) nextLoopSrc = iterSrc;
    }

    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (ts.isPropertyAccessExpression(n.left)) {
        const target = unwrapExpr(n.left.expression);
        if (ts.isIdentifier(target) && target.text === varName) {
          const propKey = getPropertyNameText(n.left.name);
          if (propKey !== null) literalKeys.add(propKey);
          else untraceableMutation = true;
        }
      } else if (ts.isElementAccessExpression(n.left)) {
        const target = unwrapExpr(n.left.expression);
        if (ts.isIdentifier(target) && target.text === varName) {
          const litKey = getStringLiteralValue(n.left.argumentExpression);
          if (litKey !== null) {
            literalKeys.add(litKey);
          } else if (nextLoopSrc) {
            sourceOutcomes.push(
              analyzeDefaultsExpr(nextLoopSrc, "defaultFlags", ctx, callDepth + 1)
            );
          } else {
            untraceableMutation = true;
          }
        }
      }
    }

    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      n.expression.name.text === "assign" &&
      n.arguments.length >= 2
    ) {
      const target = unwrapExpr(n.arguments[0]);
      if (ts.isIdentifier(target) && target.text === varName) {
        for (const srcArg of n.arguments.slice(1)) {
          sourceOutcomes.push(
            analyzeDefaultsExpr(srcArg, "defaultFlags", ctx, callDepth + 1)
          );
        }
      }
    }

    ts.forEachChild(n, (child) => visitScope(child, nextLoopSrc));
  };

  visitScope(scopeNode, null);

  if (untraceableMutation) {
    return {
      status: "unverified",
      detail: "defaults object is populated from an unresolvable source",
    };
  }

  for (const o of sourceOutcomes) {
    if (o.status === "unverified") return o;
    if (o.status === "missing_defaults") {
      return {
        status: "unverified",
        detail: "defaults object is populated from an unresolvable source",
      };
    }
  }

  const keys = new Set(literalKeys);
  let hasDynamic = false;
  for (const o of sourceOutcomes) {
    if (o.status === "ok") {
      if (o.kind === "literal" && o.keys) {
        for (const k of o.keys) keys.add(k);
      } else {
        hasDynamic = true;
      }
    }
  }

  if (keys.size > 0) return { status: "ok", kind: "literal", keys };
  if (hasDynamic) return { status: "ok", kind: "dynamic" };
  return { status: "empty_defaults" };
}

function analyzeObjectFromEntries(callExpr, ctx, callDepth) {
  const arg = callExpr.arguments[0] ? unwrapExpr(callExpr.arguments[0]) : null;
  if (!arg) {
    return {
      status: "unverified",
      detail: "Object.fromEntries() has no traceable source",
    };
  }

  let entriesExpr = arg;
  if (
    ts.isCallExpression(entriesExpr) &&
    ts.isPropertyAccessExpression(entriesExpr.expression) &&
    entriesExpr.expression.name.text === "map"
  ) {
    entriesExpr = unwrapExpr(entriesExpr.expression.expression);
  }

  if (
    ts.isCallExpression(entriesExpr) &&
    ts.isPropertyAccessExpression(entriesExpr.expression) &&
    ts.isIdentifier(entriesExpr.expression.expression) &&
    entriesExpr.expression.expression.text === "Object" &&
    (entriesExpr.expression.name.text === "entries" ||
      entriesExpr.expression.name.text === "keys") &&
    entriesExpr.arguments.length >= 1
  ) {
    return analyzeDefaultsExpr(
      entriesExpr.arguments[0],
      "defaultFlags",
      ctx,
      callDepth + 1
    );
  }

  return {
    status: "unverified",
    detail: "Object.fromEntries() source cannot be traced statically",
  };
}

function analyzeHelperCallDefaults(callExpr, keyName, ctx, callDepth = 0) {
  if (callDepth > 3) {
    return {
      status: "unverified",
      detail: `${keyName} helper call depth exceeded static limit`,
    };
  }

  const callee = unwrapExpr(callExpr.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "fromEntries"
  ) {
    return analyzeObjectFromEntries(callExpr, ctx, callDepth);
  }

  if (!ts.isIdentifier(callee) || !ctx.localFunctions?.has(callee.text)) {
    return {
      status: "unverified",
      detail: `${keyName} helper call cannot be traced statically`,
    };
  }

  const fnNode = ctx.localFunctions.get(callee.text);
  const paramBindings = new Map();
  fnNode.parameters.forEach((param, idx) => {
    if (ts.isIdentifier(param.name)) {
      const argExpr = callExpr.arguments[idx] ?? param.initializer ?? null;
      if (argExpr) {
        paramBindings.set(param.name.text, { expr: argExpr, ctx });
      }
    }
  });

  const fnConsts = new Map(ctx.localConstBindings);
  const fnDecls = new Map(ctx.localConstDecls);
  const returns = [];

  const collectFnBody = (n) => {
    if (
      n !== fnNode.body &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n))
    ) {
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      fnDecls.set(n.name.text, n);
      if (n.parent && (n.parent.flags & ts.NodeFlags.Const)) {
        fnConsts.set(n.name.text, unwrapExpr(n.initializer));
      }
    }
    if (ts.isReturnStatement(n)) {
      returns.push(n.expression ?? null);
    }
    ts.forEachChild(n, collectFnBody);
  };

  const fnCtx = {
    ...ctx,
    paramBindings,
    localConstBindings: fnConsts,
    localConstDecls: fnDecls,
  };

  if (!ts.isBlock(fnNode.body)) {
    return analyzeDefaultsExpr(fnNode.body, keyName, fnCtx, callDepth + 1);
  }

  collectFnBody(fnNode.body);
  if (returns.length === 0) {
    return { status: "missing_defaults" };
  }

  const outcomes = [];
  for (const retExpr of returns) {
    if (!retExpr) {
      outcomes.push({ status: "missing_defaults" });
      continue;
    }
    const unwrappedRet = unwrapExpr(retExpr);
    if (ts.isIdentifier(unwrappedRet) && fnDecls.has(unwrappedRet.text)) {
      const decl = fnDecls.get(unwrappedRet.text);
      const declInit = decl.initializer ? unwrapExpr(decl.initializer) : null;
      if (
        declInit &&
        ts.isObjectLiteralExpression(declInit) &&
        declInit.properties.length === 0
      ) {
        outcomes.push(
          traceLocalObjectPopulation(unwrappedRet.text, fnNode.body, fnCtx, callDepth + 1)
        );
        continue;
      }
    }
    outcomes.push(analyzeDefaultsExpr(retExpr, keyName, fnCtx, callDepth + 1));
  }

  return combineOutcomes(outcomes, "missing_defaults");
}

function analyzeDefaultsExpr(valExpr, keyName, ctx, callDepth = 0) {
  if (isNullishOrFalseExpr(valExpr)) {
    return { status: "missing_defaults" };
  }
  const unwrapped = unwrapExpr(valExpr);

  if (
    keyName === "defaultFlagHandler" ||
    keyName === "default_flag_handler" ||
    keyName === "offlineHandler"
  ) {
    return { status: "ok", kind: "dynamic" };
  }

  if (ts.isIdentifier(unwrapped)) {
    const name = unwrapped.text;
    if (ctx.paramBindings?.has(name)) {
      const bound = ctx.paramBindings.get(name);
      return analyzeDefaultsExpr(bound.expr, keyName, bound.ctx, callDepth + 1);
    }
    if (isIdentifierEnclosingParam(unwrapped)) {
      return {
        status: "unverified",
        detail: `${keyName} is a parameter with no resolvable source`,
      };
    }
  }

  const jsonRes = resolveJsonValue(unwrapped, ctx);
  if (jsonRes.resolved) {
    let targetVal = jsonRes.value;
    if (
      (keyName === "state" || keyName === "serverState") &&
      isPlainObject(targetVal) &&
      Object.prototype.hasOwnProperty.call(targetVal, "flags")
    ) {
      targetVal = targetVal.flags;
    }
    if (targetVal === null || targetVal === undefined || targetVal === false) {
      return { status: "missing_defaults" };
    }
    if (isPlainObject(targetVal)) {
      const keys = Object.keys(targetVal);
      if (keys.length === 0) return { status: "empty_defaults" };
      return { status: "ok", kind: "literal", keys: new Set(keys) };
    }
    return {
      status: "unverified",
      detail: `${keyName} JSON value is not a flag map object`,
    };
  }

  if (ts.isCallExpression(unwrapped)) {
    return analyzeHelperCallDefaults(unwrapped, keyName, ctx, callDepth);
  }

  if (ts.isIdentifier(unwrapped)) {
    const name = unwrapped.text;
    if (ctx.importedProjectSymbols?.has(name) && ctx.projectIndex) {
      const sym = ctx.importedProjectSymbols.get(name);
      const exp = ctx.projectIndex.exportedValuesByFile
        .get(sym.targetFilePath)
        ?.get(sym.exportName);
      const targetCtx = ctx.projectIndex.fileContextByPath.get(sym.targetFilePath);
      if (exp && targetCtx) {
        return analyzeDefaultsExpr(
          exp.expr,
          keyName,
          { ...targetCtx, jsonCache: ctx.jsonCache, projectIndex: ctx.projectIndex },
          callDepth + 1
        );
      }
    }

    if (ctx.localConstDecls?.has(name)) {
      const decl = ctx.localConstDecls.get(name);
      const declInit = decl.initializer ? unwrapExpr(decl.initializer) : null;
      if (
        declInit &&
        ts.isObjectLiteralExpression(declInit) &&
        declInit.properties.length === 0
      ) {
        return traceLocalObjectPopulation(
          name,
          findEnclosingScope(decl),
          ctx,
          callDepth + 1
        );
      }
      if (declInit) {
        return analyzeDefaultsExpr(declInit, keyName, ctx, callDepth + 1);
      }
    }
  }

  const res = resolveObjectProperties(unwrapped, ctx);
  if (!res.resolved) {
    return {
      status: "unverified",
      detail: `${keyName} expression cannot be resolved statically`,
    };
  }

  if (keyName === "state" || keyName === "serverState") {
    if (res.props.has("flags")) {
      return analyzeDefaultsExpr(res.props.get("flags").expr, "defaultFlags", ctx, callDepth + 1);
    }
    if (res.props.size === 0 && !res.hasUnresolvedSpread && !res.hasComputedProp) {
      return { status: "empty_defaults" };
    }
    if (res.hasUnresolvedSpread) {
      return {
        status: "unverified",
        detail: `${keyName} contains an unresolved spread`,
      };
    }
    return { status: "missing_defaults" };
  }

  if (res.props.size === 0 && !res.hasUnresolvedSpread && !res.hasComputedProp) {
    return { status: "empty_defaults" };
  }
  if (res.props.size === 0 && res.hasUnresolvedSpread) {
    return {
      status: "unverified",
      detail: `${keyName} spread cannot be resolved statically`,
    };
  }
  if (res.props.size === 0 && res.hasComputedProp) {
    return { status: "ok", kind: "dynamic" };
  }

  return {
    status: "ok",
    kind: res.hasUnresolvedSpread || res.hasComputedProp ? "dynamic" : "literal",
    keys: new Set(res.props.keys()),
  };
}

function analyzeInitConfig(configArg, ctx) {
  if (!configArg) {
    return { status: "missing_defaults" };
  }
  const res = resolveObjectProperties(configArg, ctx);
  if (!res.resolved) {
    return {
      status: "unverified",
      detail: "init() config expression cannot be resolved statically",
    };
  }

  let sawMissing = false;
  for (const key of OFFLINE_DEFAULT_KEYS) {
    if (!res.props.has(key)) continue;
    const outcome = analyzeDefaultsExpr(res.props.get(key).expr, key, ctx);
    if (outcome.status === "missing_defaults") {
      sawMissing = true;
      continue;
    }
    return outcome;
  }

  if (!sawMissing && res.hasUnresolvedSpread) {
    return {
      status: "unverified",
      detail: "init() config spread cannot be resolved statically",
    };
  }
  return { status: "missing_defaults" };
}

function optionsHasExplicitFallback(expr, localConstBindings) {
  const res = resolveObjectProperties(expr, localConstBindings);
  if (!res.resolved) return false;
  if (!res.props.has("fallback")) return false;
  const init = unwrapExpr(res.props.get("fallback").expr);
  return (
    init.kind !== ts.SyntaxKind.UndefinedKeyword &&
    !(ts.isIdentifier(init) && init.text === "undefined")
  );
}

function blockContainsThrow(node) {
  if (!node) return false;
  let foundThrow = false;

  const visitBlock = (n) => {
    if (foundThrow) return;
    if (ts.isThrowStatement(n)) {
      foundThrow = true;
      return;
    }
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n)
    ) {
      return;
    }
    if (
      ts.isTryStatement(n) &&
      n.catchClause &&
      !blockContainsThrow(n.catchClause.block)
    ) {
      if (n.finallyBlock) visitBlock(n.finallyBlock);
      return;
    }
    ts.forEachChild(n, visitBlock);
  };

  visitBlock(node);
  return foundThrow;
}

function isHandlingCallback(expr) {
  if (!expr) return false;
  const unwrapped = unwrapExpr(expr);
  if (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    unwrapped.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined")
  ) {
    return false;
  }
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    if (ts.isBlock(unwrapped.body)) {
      return !blockContainsThrow(unwrapped.body);
    }
    return true;
  }
  return true;
}

function isAwaitInNonRethrowingTry(awaitNode) {
  let walker = awaitNode;
  while (walker && walker.parent) {
    const p = walker.parent;
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isSourceFile(p)
    ) {
      break;
    }
    if (ts.isTryStatement(p) && p.tryBlock === walker) {
      if (p.catchClause && !blockContainsThrow(p.catchClause.block)) {
        return true;
      }
    }
    walker = p;
  }
  return false;
}

/**
 * Checks whether a Flagsmith `init()` call has non-rethrowing rejection handling
 * (`.catch(...)` or enclosing `try/catch` around an `await`).
 * Flags fire-and-forget `init()` calls without `.catch()` as well as unguarded awaits/returns.
 */
function checkInitRejectionHandling(initCallNode) {
  let chainTop = initCallNode;
  let hasNonRethrowingCatch = false;

  while (chainTop.parent) {
    const p = chainTop.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      chainTop = p;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === chainTop &&
      p.parent &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      const chainedCall = p.parent;
      const method = p.name.text;
      if (method === "catch") {
        if (isHandlingCallback(chainedCall.arguments[0])) {
          hasNonRethrowingCatch = true;
        }
        chainTop = chainedCall;
        continue;
      }
      if (method === "then") {
        if (
          chainedCall.arguments.length >= 2 &&
          isHandlingCallback(chainedCall.arguments[1])
        ) {
          hasNonRethrowingCatch = true;
        }
        chainTop = chainedCall;
        continue;
      }
      if (method === "finally") {
        chainTop = chainedCall;
        continue;
      }
    }
    break;
  }

  if (hasNonRethrowingCatch) {
    return { ok: true };
  }

  // Handle `const p = client.init(...); p.catch(...)` or `await p;` inside try/catch
  if (
    chainTop.parent &&
    ts.isVariableDeclaration(chainTop.parent) &&
    chainTop.parent.initializer === chainTop &&
    ts.isIdentifier(chainTop.parent.name)
  ) {
    const promiseVar = chainTop.parent.name.text;
    const scope = findEnclosingScope(chainTop.parent);
    let handled = false;
    const inspectPromiseVar = (n) => {
      if (handled || n === chainTop.parent) return;
      if (ts.isIdentifier(n) && n.text === promiseVar) {
        if (
          n.parent &&
          ts.isPropertyAccessExpression(n.parent) &&
          n.parent.expression === n &&
          n.parent.name.text === "catch" &&
          n.parent.parent &&
          ts.isCallExpression(n.parent.parent) &&
          isHandlingCallback(n.parent.parent.arguments[0])
        ) {
          handled = true;
          return;
        }
        if (n.parent && ts.isAwaitExpression(n.parent) && isAwaitInNonRethrowingTry(n.parent)) {
          handled = true;
          return;
        }
      }
      ts.forEachChild(n, inspectPromiseVar);
    };
    inspectPromiseVar(scope);
    if (handled) {
      return { ok: true };
    }
  }

  let isAwaited = false;
  let isReturned = false;
  let awaitNode = null;

  let curr = chainTop;
  while (curr.parent) {
    const p = curr.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      curr = p;
      continue;
    }
    if (ts.isAwaitExpression(p) && p.expression === curr) {
      isAwaited = true;
      awaitNode = p;
      break;
    }
    if (ts.isReturnStatement(p) && p.expression === curr) {
      isReturned = true;
      break;
    }
    if (ts.isArrowFunction(p) && p.body === curr) {
      isReturned = true;
      break;
    }
    break;
  }

  if (!isAwaited && !isReturned) {
    return {
      ok: false,
      code: "missing_rejection_handler",
      reason:
        "missing_rejection_handler: fire-and-forget init() has no .catch() handler (flagsmith/isomorphic rejects on network failure even with defaultFlags)",
    };
  }

  if (isReturned && !isAwaited) {
    return {
      ok: false,
      code: "missing_rejection_handler",
      reason:
        "missing_rejection_handler: returned init() has no .catch() handler (flagsmith/isomorphic rejects on network failure even with defaultFlags)",
    };
  }

  if (isAwaitInNonRethrowingTry(awaitNode)) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "missing_rejection_handler",
    reason:
      "missing_rejection_handler: awaited init() has no non-rethrowing try/catch or .catch() handler (flagsmith/isomorphic rejects on network failure even with defaultFlags)",
  };
}

function isWrappedInInlineFallback(node) {
  let curr = node;
  let parent = node.parent;

  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent))
  ) {
    curr = parent;
    parent = parent.parent;
  }

  if (!parent) return false;

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === curr &&
    (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return true;
  }

  if (ts.isConditionalExpression(parent) && parent.condition === curr) {
    return true;
  }

  if (ts.isBindingElement(parent) && parent.initializer) {
    return true;
  }

  return false;
}

function conditionNarrowsVarTruthy(cond, varName) {
  const expr = unwrapExpr(cond);
  if (!expr) return false;
  if (ts.isIdentifier(expr) && expr.text === varName) {
    return true;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return (
        conditionNarrowsVarTruthy(expr.left, varName) ||
        conditionNarrowsVarTruthy(expr.right, varName)
      );
    }
    if (
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const left = unwrapExpr(expr.left);
      const right = unwrapExpr(expr.right);
      const isNullish = (n) =>
        n.kind === ts.SyntaxKind.NullKeyword ||
        n.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(n) && n.text === "undefined");
      if (
        (ts.isIdentifier(left) && left.text === varName && isNullish(right)) ||
        (ts.isIdentifier(right) && right.text === varName && isNullish(left))
      ) {
        return true;
      }
    }
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken
    ) {
      const left = unwrapExpr(expr.left);
      const right = unwrapExpr(expr.right);
      if (
        ts.isTypeOfExpression(left) &&
        ts.isIdentifier(unwrapExpr(left.expression)) &&
        unwrapExpr(left.expression).text === varName &&
        ts.isStringLiteral(right) &&
        right.text !== "undefined" &&
        right.text !== "object"
      ) {
        return true;
      }
    }
  }
  return false;
}

function isIdentifierGuardedRead(refNode, varName) {
  if (isWrappedInInlineFallback(refNode)) {
    return true;
  }

  // Optional chain: v?.trim() ?? ""
  let chain = refNode;
  while (
    chain.parent &&
    ((ts.isPropertyAccessExpression(chain.parent) &&
      chain.parent.expression === chain &&
      chain.parent.questionDotToken) ||
      (ts.isElementAccessExpression(chain.parent) &&
        chain.parent.expression === chain &&
        chain.parent.questionDotToken) ||
      (ts.isCallExpression(chain.parent) &&
        chain.parent.expression === chain &&
        chain.parent.questionDotToken))
  ) {
    chain = chain.parent;
    while (
      chain.parent &&
      ((ts.isPropertyAccessExpression(chain.parent) &&
        chain.parent.expression === chain) ||
        (ts.isElementAccessExpression(chain.parent) &&
          chain.parent.expression === chain) ||
        (ts.isCallExpression(chain.parent) && chain.parent.expression === chain))
    ) {
      chain = chain.parent;
    }
    if (isWrappedInInlineFallback(chain)) {
      return true;
    }
  }

  // Check if refNode is directly being inspected for nullishness/truthiness or inside a narrowed branch
  let walker = refNode;
  while (walker.parent) {
    const p = walker.parent;
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isSourceFile(p)
    ) {
      break;
    }
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
      return true;
    }
    if (ts.isTypeOfExpression(p) && p.expression === walker) {
      return true;
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        return true;
      }
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken &&
        p.right === walker &&
        conditionNarrowsVarTruthy(p.left, varName)
      ) {
        return true;
      }
    }
    if (ts.isIfStatement(p)) {
      if (p.expression === walker) return true;
      if (p.thenStatement === walker && conditionNarrowsVarTruthy(p.expression, varName)) {
        return true;
      }
    }
    if (ts.isConditionalExpression(p)) {
      if (p.condition === walker) return true;
      if (p.whenTrue === walker && conditionNarrowsVarTruthy(p.expression, varName)) {
        return true;
      }
    }
    walker = p;
  }

  return false;
}

function isVariableReadPosition(idNode) {
  const p = idNode.parent;
  if (!p) return false;
  if (ts.isVariableDeclaration(p) && p.name === idNode) return false;
  if (ts.isParameter(p) && p.name === idNode) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === idNode) return false;
  if (ts.isPropertyAssignment(p) && p.name === idNode) return false;
  if (ts.isBindingElement(p) && (p.name === idNode || p.propertyName === idNode)) {
    return false;
  }
  if (ts.isTypeNode(p) || ts.isTypeReferenceNode(p)) return false;
  return true;
}

function scopeShadowedByInnerDecl(node, varName) {
  if (
    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === varName
  ) {
    return true;
  }
  return false;
}

/**
 * Checks Case F: `const v = client.getValue("promo");` where every subsequent
 * use of `v` in the enclosing scope is guarded (e.g. `return v ?? "d";`).
 */
function checkConstBindingAllUsesGuarded(callNode) {
  let exprTop = callNode;
  while (
    exprTop.parent &&
    (ts.isParenthesizedExpression(exprTop.parent) ||
      ts.isAwaitExpression(exprTop.parent) ||
      ts.isSatisfiesExpression(exprTop.parent))
  ) {
    exprTop = exprTop.parent;
  }

  const decl = exprTop.parent;
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer !== exprTop ||
    !ts.isIdentifier(decl.name) ||
    !decl.parent ||
    !(decl.parent.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }

  const varName = decl.name.text;
  const scope = findEnclosingScope(decl);
  let readCount = 0;
  let allGuarded = true;

  const visitScope = (n) => {
    if (!allGuarded) return;
    if (n === decl) return;
    if (scopeShadowedByInnerDecl(n, varName)) return;

    if (ts.isIdentifier(n) && n.text === varName && isVariableReadPosition(n)) {
      readCount += 1;
      if (!isIdentifierGuardedRead(n, varName)) {
        allGuarded = false;
        return;
      }
    }
    ts.forEachChild(n, visitScope);
  };

  visitScope(scope);
  return readCount > 0 && allGuarded;
}

function hasExportModifier(node) {
  return Boolean(
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function collectInterfacePropertyTypes(sourceFile) {
  const interfaces = new Map();

  const recordMembers = (typeName, members) => {
    const propMap = new Map();
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.type) {
        const propName = getPropertyNameText(member.name);
        const propType = getTypeName(member.type);
        if (propName && propType) {
          propMap.set(propName, propType);
        }
      }
    }
    if (propMap.size > 0) {
      interfaces.set(typeName, propMap);
    }
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      recordMembers(stmt.name.text, stmt.members);
    } else if (
      ts.isTypeAliasDeclaration(stmt) &&
      ts.isTypeLiteralNode(stmt.type)
    ) {
      recordMembers(stmt.name.text, stmt.type.members);
    }
  }

  return interfaces;
}

function resolveRelativeSourceFile(fromFilePath, specifier, parsedFileSet) {
  if (!specifier || (!specifier.startsWith("./") && !specifier.startsWith("../"))) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFilePath), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) {
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  for (const cand of candidates) {
    const norm = path.resolve(cand);
    if (parsedFileSet.has(norm)) return norm;
  }
  return null;
}

/**
 * Pass 1: Collect exported interfaces/types, exported Flagsmith instances,
 * and exported const/default value expressions across all source files.
 */
function buildProjectExportIndex(parsedFiles) {
  const exportedContainerTypes = new Map();
  const exportedInstanceNames = new Set();
  const exportedValuesByFile = new Map();
  const fileContextByPath = new Map();
  const parsedFileSet = new Set(parsedFiles.map((f) => path.resolve(f.filePath)));

  for (const { filePath, sourceFile } of parsedFiles) {
    const normPath = path.resolve(filePath);
    const exportsMap = new Map();
    const topConsts = new Map();
    const topDecls = new Map();
    const jsonImportPaths = new Map();
    const importedProjectSymbols = new Map();
    const localFunctions = new Map();

    const localFactories = new Set();
    const localClasses = new Set();
    const localInstances = new Set();

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        localFunctions.set(stmt.name.text, stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = unwrapExpr(decl.initializer);
          topDecls.set(decl.name.text, decl);
          if (stmt.declarationList.flags & ts.NodeFlags.Const) {
            topConsts.set(decl.name.text, init);
          }
          if (
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            init.body
          ) {
            localFunctions.set(decl.name.text, init);
          }
        }
      }

      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const mod = stmt.moduleSpecifier.text;
        const clause = stmt.importClause;
        if (!clause || clause.isTypeOnly) continue;

        if (mod.endsWith(".json")) {
          const jsonAbs = path.resolve(path.dirname(filePath), mod);
          if (clause.name) jsonImportPaths.set(clause.name.text, { filePath: jsonAbs, propName: null });
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            jsonImportPaths.set(clause.namedBindings.name.text, { filePath: jsonAbs, propName: null });
          } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              const impName = el.propertyName ? el.propertyName.text : el.name.text;
              jsonImportPaths.set(el.name.text, { filePath: jsonAbs, propName: impName });
            }
          }
          continue;
        }

        if (FLAGSMITH_MODULE_RE.test(mod)) {
          if (clause.name) localInstances.add(clause.name.text);
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              const imported = el.propertyName ? el.propertyName.text : el.name.text;
              const local = el.name.text;
              if (imported === "createFlagsmithInstance" || imported === "useFlagsmith") {
                localFactories.add(local);
              } else if (imported === "Flagsmith") {
                localClasses.add(local);
              }
            }
          }
        } else {
          const targetFilePath = resolveRelativeSourceFile(filePath, mod, parsedFileSet);
          if (targetFilePath) {
            if (clause.name) {
              importedProjectSymbols.set(clause.name.text, {
                targetFilePath,
                exportName: "default",
              });
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                if (el.isTypeOnly) continue;
                const imported = el.propertyName ? el.propertyName.text : el.name.text;
                importedProjectSymbols.set(el.name.text, {
                  targetFilePath,
                  exportName: imported,
                });
              }
            }
          }
        }
      }
    }

    for (const stmt of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(stmt) && hasExportModifier(stmt)) {
        const props = new Set();
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.type) {
            const propName = getPropertyNameText(member.name);
            const propType = getTypeName(member.type);
            if (propName && propType && FLAGSMITH_TYPE_NAMES.has(propType)) {
              props.add(propName);
            }
          }
        }
        if (props.size > 0) {
          exportedContainerTypes.set(stmt.name.text, props);
        }
      } else if (
        ts.isTypeAliasDeclaration(stmt) &&
        hasExportModifier(stmt) &&
        ts.isTypeLiteralNode(stmt.type)
      ) {
        const props = new Set();
        for (const member of stmt.type.members) {
          if (ts.isPropertySignature(member) && member.type) {
            const propName = getPropertyNameText(member.name);
            const propType = getTypeName(member.type);
            if (propName && propType && FLAGSMITH_TYPE_NAMES.has(propType)) {
              props.add(propName);
            }
          }
        }
        if (props.size > 0) {
          exportedContainerTypes.set(stmt.name.text, props);
        }
      } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = unwrapExpr(decl.initializer);
          exportsMap.set(decl.name.text, { expr: init, filePath: normPath, sourceFile });
          if (
            (ts.isCallExpression(init) &&
              ts.isIdentifier(init.expression) &&
              localFactories.has(init.expression.text)) ||
            (ts.isNewExpression(init) &&
              ts.isIdentifier(init.expression) &&
              localClasses.has(init.expression.text)) ||
            (ts.isIdentifier(init) && localInstances.has(init.text))
          ) {
            exportedInstanceNames.add(decl.name.text);
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        exportsMap.set("default", {
          expr: unwrapExpr(stmt.expression),
          filePath: normPath,
          sourceFile,
        });
      } else if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const el of stmt.exportClause.elements) {
          const localName = el.propertyName ? el.propertyName.text : el.name.text;
          const exportName = el.name.text;
          if (topConsts.has(localName)) {
            exportsMap.set(exportName, {
              expr: topConsts.get(localName),
              filePath: normPath,
              sourceFile,
            });
          }
        }
      }
    }

    exportedValuesByFile.set(normPath, exportsMap);
    fileContextByPath.set(normPath, {
      localConstBindings: topConsts,
      localConstDecls: topDecls,
      jsonImportPaths,
      importedProjectSymbols,
      localFunctions,
      sourceFile,
    });
  }

  return {
    exportedContainerTypes,
    exportedInstanceNames,
    exportedValuesByFile,
    fileContextByPath,
    parsedFileSet,
  };
}

function findEnclosingScope(node) {
  let curr = node.parent;
  while (curr) {
    if (
      ts.isBlock(curr) ||
      ts.isArrowFunction(curr) ||
      ts.isFunctionDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isSourceFile(curr)
    ) {
      return curr;
    }
    curr = curr.parent;
  }
  return node.getSourceFile();
}

function getLineNumber(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scanSingleFile(filePath, sourceFile, projectIndex, jsonCache = new Map()) {
  const relFile = toPosixRelative(filePath);

  const flagsmithNamespaces = new Set();
  const flagsmithInstances = new Set();
  const flagsmithThisProps = new Set();
  const instanceFactories = new Set();
  const flagsmithClasses = new Set();
  const providerNames = new Set();
  const useFlagsNames = new Set();
  const localConstBindings = new Map();
  const localConstDecls = new Map();
  const jsonImportPaths = new Map();
  const importedProjectSymbols = new Map();
  const localFunctions = new Map();
  const typedVars = new Map();
  const localInterfaces = collectInterfacePropertyTypes(sourceFile);
  const containerTypes = new Map(projectIndex.exportedContainerTypes);

  let runtimeClientImportLine = null;
  let exportsTrackedInstance = false;

  for (const [ifaceName, propMap] of localInterfaces.entries()) {
    const fsProps = new Set();
    for (const [propName, propType] of propMap.entries()) {
      if (FLAGSMITH_TYPE_NAMES.has(propType)) {
        fsProps.add(propName);
      }
    }
    if (fsProps.size > 0) {
      containerTypes.set(ifaceName, fsProps);
    }
  }

  // 1. Collect ES imports
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const mod = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) continue;

      if (mod.endsWith(".json") && !clause.isTypeOnly) {
        const jsonAbs = path.resolve(path.dirname(filePath), mod);
        if (clause.name) jsonImportPaths.set(clause.name.text, { filePath: jsonAbs, propName: null });
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          jsonImportPaths.set(clause.namedBindings.name.text, { filePath: jsonAbs, propName: null });
        } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const impName = el.propertyName ? el.propertyName.text : el.name.text;
            jsonImportPaths.set(el.name.text, { filePath: jsonAbs, propName: impName });
          }
        }
        continue;
      }

      if (FLAGSMITH_MODULE_RE.test(mod)) {
        if (clause.isTypeOnly) continue;
        const importLine = getLineNumber(sourceFile, stmt);
        if (clause.name) {
          if (mod === "flagsmith-nodejs") {
            flagsmithClasses.add(clause.name.text);
          } else {
            flagsmithInstances.add(clause.name.text);
          }
          if (runtimeClientImportLine === null) runtimeClientImportLine = importLine;
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            flagsmithNamespaces.add(clause.namedBindings.name.text);
            if (runtimeClientImportLine === null) runtimeClientImportLine = importLine;
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              const imported = el.propertyName ? el.propertyName.text : el.name.text;
              const local = el.name.text;
              if (RUNTIME_CLIENT_IMPORT_NAMES.has(imported)) {
                if (runtimeClientImportLine === null) runtimeClientImportLine = importLine;
              }
              if (imported === "createFlagsmithInstance" || imported === "useFlagsmith") {
                instanceFactories.add(local);
              } else if (imported === "Flagsmith") {
                flagsmithClasses.add(local);
              } else if (imported === "FlagsmithProvider") {
                providerNames.add(local);
              } else if (imported === "useFlags") {
                useFlagsNames.add(local);
              } else if (imported === "default") {
                flagsmithInstances.add(local);
              }
            }
          }
        }
      } else if (!clause.isTypeOnly) {
        const targetFilePath = resolveRelativeSourceFile(
          filePath,
          mod,
          projectIndex.parsedFileSet
        );
        if (targetFilePath) {
          if (clause.name) {
            importedProjectSymbols.set(clause.name.text, {
              targetFilePath,
              exportName: "default",
            });
          }
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              const imported = el.propertyName ? el.propertyName.text : el.name.text;
              importedProjectSymbols.set(el.name.text, {
                targetFilePath,
                exportName: imported,
              });
            }
          }
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (el.isTypeOnly) continue;
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            const local = el.name.text;
            if (projectIndex.exportedInstanceNames.has(imported)) {
              flagsmithInstances.add(local);
            }
            if (projectIndex.exportedContainerTypes.has(imported)) {
              containerTypes.set(local, projectIndex.exportedContainerTypes.get(imported));
            }
          }
        }
      }
    }
  }

  const isFactoryCall = (expr) => {
    const unwrapped = unwrapExpr(expr);
    if (!ts.isCallExpression(unwrapped)) return false;
    const callee = unwrapped.expression;
    if (ts.isIdentifier(callee) && instanceFactories.has(callee.text)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      flagsmithNamespaces.has(callee.expression.text) &&
      (callee.name.text === "createFlagsmithInstance" ||
        callee.name.text === "useFlagsmith")
    ) {
      return true;
    }
    return false;
  };

  const isFlagsmithNewExpr = (expr) => {
    const unwrapped = unwrapExpr(expr);
    if (!ts.isNewExpression(unwrapped)) return false;
    const callee = unwrapped.expression;
    if (ts.isIdentifier(callee) && flagsmithClasses.has(callee.text)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      flagsmithNamespaces.has(callee.expression.text) &&
      callee.name.text === "Flagsmith"
    ) {
      return true;
    }
    return false;
  };

  const recordTypedBinding = (nameNode, typeNode) => {
    if (!typeNode) return;
    if (ts.isIdentifier(nameNode)) {
      const typeName = getTypeName(typeNode);
      if (typeName) {
        if (FLAGSMITH_TYPE_NAMES.has(typeName)) {
          flagsmithInstances.add(nameNode.text);
        } else if (containerTypes.has(typeName)) {
          typedVars.set(nameNode.text, typeName);
        }
      }
    } else if (ts.isObjectBindingPattern(nameNode)) {
      let propTypeLookup = null;
      if (ts.isTypeLiteralNode(typeNode)) {
        propTypeLookup = new Map();
        for (const member of typeNode.members) {
          if (ts.isPropertySignature(member) && member.type) {
            const pName = getPropertyNameText(member.name);
            const pType = getTypeName(member.type);
            if (pName && pType) propTypeLookup.set(pName, pType);
          }
        }
      } else {
        const ifaceName = getTypeName(typeNode);
        if (ifaceName && localInterfaces.has(ifaceName)) {
          propTypeLookup = localInterfaces.get(ifaceName);
        }
      }
      if (!propTypeLookup) return;
      for (const el of nameNode.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const propKey = el.propertyName
          ? getPropertyNameText(el.propertyName)
          : el.name.text;
        const localName = el.name.text;
        const propType = propKey ? propTypeLookup.get(propKey) : null;
        if (!propType) continue;
        if (FLAGSMITH_TYPE_NAMES.has(propType)) {
          flagsmithInstances.add(localName);
        } else if (containerTypes.has(propType)) {
          typedVars.set(localName, propType);
        }
      }
    }
  };

  const isFlagsmithReceiver = (expr) => {
    const unwrapped = unwrapExpr(expr);
    if (ts.isIdentifier(unwrapped)) {
      return (
        flagsmithInstances.has(unwrapped.text) ||
        flagsmithNamespaces.has(unwrapped.text)
      );
    }
    if (isFactoryCall(unwrapped) || isFlagsmithNewExpr(unwrapped)) {
      return true;
    }
    if (isFlagsSnapshotExpr(unwrapped)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const obj = unwrapExpr(unwrapped.expression);
      const prop = getPropertyNameText(unwrapped.name);
      if (!prop) return false;

      if (obj.kind === ts.SyntaxKind.ThisKeyword && flagsmithThisProps.has(prop)) {
        return true;
      }
      if (
        ts.isIdentifier(obj) &&
        flagsmithNamespaces.has(obj.text) &&
        prop === "default"
      ) {
        return true;
      }
      if (ts.isIdentifier(obj) && typedVars.has(obj.text)) {
        const typeName = typedVars.get(obj.text);
        const fsProps = containerTypes.get(typeName);
        if (fsProps && fsProps.has(prop)) {
          return true;
        }
      }
    }
    return false;
  };

  function isFlagsSnapshotExpr(expr) {
    let inner = unwrapExpr(expr);
    if (ts.isAwaitExpression(inner)) {
      inner = unwrapExpr(inner.expression);
    }
    if (!ts.isCallExpression(inner) || !ts.isPropertyAccessExpression(inner.expression)) {
      return false;
    }
    const method = inner.expression.name.text;
    if (method !== "getEnvironmentFlags" && method !== "getIdentityFlags") {
      return false;
    }
    return isFlagsmithReceiver(inner.expression.expression);
  }

  // 2. Collect bindings, class fields, require() calls, const objects, and local helpers
  const collectBindings = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      localFunctions.set(node.name.text, node);
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.type) {
        recordTypedBinding(node.name, node.type);
      }

      if (node.initializer) {
        const init = unwrapExpr(node.initializer);

        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          init.arguments.length === 1
        ) {
          const mod = getStringLiteralValue(init.arguments[0]);
          if (mod && mod.endsWith(".json")) {
            const jsonAbs = path.resolve(path.dirname(filePath), mod);
            if (ts.isIdentifier(node.name)) {
              jsonImportPaths.set(node.name.text, { filePath: jsonAbs, propName: null });
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                if (ts.isIdentifier(el.name)) {
                  const impName = el.propertyName
                    ? getPropertyNameText(el.propertyName)
                    : el.name.text;
                  jsonImportPaths.set(el.name.text, {
                    filePath: jsonAbs,
                    propName: impName,
                  });
                }
              }
            }
          } else if (mod && FLAGSMITH_MODULE_RE.test(mod)) {
            const reqLine = getLineNumber(sourceFile, node);
            if (ts.isIdentifier(node.name)) {
              if (mod === "flagsmith-nodejs") {
                flagsmithClasses.add(node.name.text);
              } else {
                flagsmithInstances.add(node.name.text);
              }
              if (runtimeClientImportLine === null) runtimeClientImportLine = reqLine;
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                if (!ts.isIdentifier(el.name)) continue;
                const imported = el.propertyName
                  ? getPropertyNameText(el.propertyName)
                  : el.name.text;
                const local = el.name.text;
                if (RUNTIME_CLIENT_IMPORT_NAMES.has(imported)) {
                  if (runtimeClientImportLine === null) runtimeClientImportLine = reqLine;
                }
                if (imported === "createFlagsmithInstance" || imported === "useFlagsmith") {
                  instanceFactories.add(local);
                } else if (imported === "Flagsmith") {
                  flagsmithClasses.add(local);
                } else if (imported === "FlagsmithProvider") {
                  providerNames.add(local);
                } else if (imported === "useFlags") {
                  useFlagsNames.add(local);
                }
              }
            }
          } else if (mod) {
            const targetFilePath = resolveRelativeSourceFile(
              filePath,
              mod,
              projectIndex.parsedFileSet
            );
            if (targetFilePath) {
              if (ts.isIdentifier(node.name)) {
                importedProjectSymbols.set(node.name.text, {
                  targetFilePath,
                  exportName: "default",
                });
              } else if (ts.isObjectBindingPattern(node.name)) {
                for (const el of node.name.elements) {
                  if (!ts.isIdentifier(el.name)) continue;
                  const impName = el.propertyName
                    ? getPropertyNameText(el.propertyName)
                    : el.name.text;
                  importedProjectSymbols.set(el.name.text, {
                    targetFilePath,
                    exportName: impName,
                  });
                }
              }
            }
          }
        }

        if (ts.isIdentifier(node.name)) {
          localConstDecls.set(node.name.text, node);
          if (node.parent && (node.parent.flags & ts.NodeFlags.Const)) {
            localConstBindings.set(node.name.text, init);
            if (
              (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
              init.body
            ) {
              localFunctions.set(node.name.text, init);
            }
          }
          if (
            isFactoryCall(init) ||
            isFlagsmithNewExpr(init) ||
            isFlagsSnapshotExpr(init) ||
            (ts.isIdentifier(init) && flagsmithInstances.has(init.text))
          ) {
            flagsmithInstances.add(node.name.text);
            if (
              node.parent?.parent &&
              ts.isVariableStatement(node.parent.parent) &&
              hasExportModifier(node.parent.parent)
            ) {
              exportsTrackedInstance = true;
            }
          }
        }
      }
    }

    // Class field initializers (`private client = createFlagsmithInstance();` or typed `client: IFlagsmith`)
    if (ts.isPropertyDeclaration(node)) {
      const propName = getPropertyNameText(node.name);
      if (propName) {
        if (node.type && FLAGSMITH_TYPE_NAMES.has(getTypeName(node.type))) {
          flagsmithThisProps.add(propName);
        }
        if (node.initializer) {
          const init = unwrapExpr(node.initializer);
          if (
            isFactoryCall(init) ||
            isFlagsmithNewExpr(init) ||
            isFlagsSnapshotExpr(init) ||
            (ts.isIdentifier(init) && flagsmithInstances.has(init.text))
          ) {
            flagsmithThisProps.add(propName);
          }
        }
      }
    }

    // Assignments (`client = ...`, `this.client = ...`)
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (
        isFactoryCall(node.right) ||
        isFlagsmithNewExpr(node.right) ||
        isFlagsSnapshotExpr(node.right) ||
        (ts.isIdentifier(unwrapExpr(node.right)) &&
          flagsmithInstances.has(unwrapExpr(node.right).text))
      ) {
        if (ts.isIdentifier(node.left)) {
          flagsmithInstances.add(node.left.text);
        } else if (
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const propName = getPropertyNameText(node.left.name);
          if (propName) flagsmithThisProps.add(propName);
        }
      }
    }

    if (ts.isParameter(node)) {
      if (node.type) {
        recordTypedBinding(node.name, node.type);
        // Constructor parameter property: `constructor(private client: IFlagsmith)`
        const isPropParam = node.modifiers?.some(
          (m) =>
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword ||
            m.kind === ts.SyntaxKind.PublicKeyword ||
            m.kind === ts.SyntaxKind.ReadonlyKeyword
        );
        if (
          isPropParam &&
          ts.isIdentifier(node.name) &&
          FLAGSMITH_TYPE_NAMES.has(getTypeName(node.type))
        ) {
          flagsmithThisProps.add(node.name.text);
        }
      }
    }

    ts.forEachChild(node, collectBindings);
  };

  // Run two passes so `this.flags = await this.client.getEnvironmentFlags()` resolves after `this.client`
  collectBindings(sourceFile);
  collectBindings(sourceFile);

  const defaultsCtx = {
    localConstBindings,
    localConstDecls,
    jsonImportPaths,
    importedProjectSymbols,
    localFunctions,
    projectIndex,
    jsonCache,
    sourceFile,
  };

  let totalInits = 0;
  let totalCalls = 0;
  const unprotectedInits = [];
  const unprotectedCalls = [];
  const referencedFlags = [];
  const literalDefaultKeySets = [];
  let hasDynamicDefaults = false;
  const unverified = [];

  const recordDefaultsOutcome = (outcome) => {
    if (outcome.status === "ok") {
      if (outcome.kind === "literal" && outcome.keys) {
        literalDefaultKeySets.push(outcome.keys);
      } else {
        hasDynamicDefaults = true;
      }
    }
  };

  const recordReferencedFlag = (flagName, line, call) => {
    if (flagName) {
      referencedFlags.push({ name: flagName, file: relFile, line, call });
    }
  };

  const analyzeUseFlagsCall = (callNode) => {
    const line = getLineNumber(sourceFile, callNode);
    const rawFirstArg = callNode.arguments[0];
    let firstArg = rawFirstArg ? unwrapExpr(rawFirstArg) : null;
    if (firstArg && ts.isIdentifier(firstArg) && localConstBindings.has(firstArg.text)) {
      firstArg = unwrapExpr(localConstBindings.get(firstArg.text));
    }

    const requestedFlags = [];
    if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
      for (const el of firstArg.elements) {
        const name = getStringLiteralValue(el);
        if (name) {
          requestedFlags.push(name);
          recordReferencedFlag(name, line, "useFlags");
        }
      }
    }

    const parent = callNode.parent;

    if (requestedFlags.length === 0) {
      totalCalls += 1;
      unverified.push({
        file: relFile,
        line,
        kind: "dynamic_flag_key",
        reason: "useFlags() uses a non-literal flag list; cannot verify offline snapshot coverage",
      });
      if (!isWrappedInInlineFallback(callNode)) {
        unprotectedCalls.push({
          file: relFile,
          line,
          call: "useFlags",
          flagName: null,
          reason: "useFlags() with non-literal flag list has no inline fallback",
        });
      }
      return;
    }

    // Case A: const { flag_a, flag_b: b } = useFlags(["flag_a", "flag_b"])
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === callNode &&
      ts.isObjectBindingPattern(parent.name)
    ) {
      const scope = findEnclosingScope(parent);
      const bindingByFlag = new Map();

      for (const el of parent.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const propName = el.propertyName
          ? getPropertyNameText(el.propertyName)
          : el.name.text;
        if (propName) {
          bindingByFlag.set(propName, {
            localName: el.name.text,
            hasDefaultInitializer: Boolean(el.initializer),
            declNode: el,
          });
        }
      }

      for (const flagName of requestedFlags) {
        totalCalls += 1;
        const binding = bindingByFlag.get(flagName);
        if (!binding) {
          unprotectedCalls.push({
            file: relFile,
            line,
            call: "useFlags",
            flagName,
            reason: "flag requested in useFlags() without fallback handling",
          });
          continue;
        }
        if (binding.hasDefaultInitializer) {
          continue;
        }

        let readCount = 0;
        let unprotectedReadLine = null;

        const visitScope = (n) => {
          if (n === binding.declNode) return;
          if (
            ts.isPropertyAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === binding.localName &&
            (n.name.text === "value" || n.name.text === "enabled")
          ) {
            readCount += 1;
            if (!isWrappedInInlineFallback(n) && unprotectedReadLine === null) {
              unprotectedReadLine = getLineNumber(sourceFile, n);
            }
            return;
          }
          ts.forEachChild(n, visitScope);
        };
        visitScope(scope);

        if (readCount === 0 || unprotectedReadLine !== null) {
          unprotectedCalls.push({
            file: relFile,
            line: unprotectedReadLine ?? line,
            call: "useFlags",
            flagName,
            reason:
              readCount === 0
                ? "destructured useFlags() flag has no fallback-guarded read"
                : "useFlags() flag property read has no inline fallback (?? / ||)",
          });
        }
      }
      return;
    }

    // Case B: const flags = useFlags(["flag_a", "flag_b"])
    if (
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.initializer === callNode &&
      ts.isIdentifier(parent.name)
    ) {
      const varName = parent.name.text;
      const scope = findEnclosingScope(parent);

      for (const flagName of requestedFlags) {
        totalCalls += 1;
        let readCount = 0;
        let unprotectedReadLine = null;

        const visitScope = (n) => {
          if (n === parent) return;

          let matchedFlagAccess = null;
          if (
            ts.isPropertyAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === varName &&
            n.name.text === flagName
          ) {
            matchedFlagAccess = n;
          } else if (
            ts.isElementAccessExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === varName &&
            getStringLiteralValue(n.argumentExpression) === flagName
          ) {
            matchedFlagAccess = n;
          }

          if (matchedFlagAccess) {
            let targetExpr = matchedFlagAccess;
            if (
              matchedFlagAccess.parent &&
              ts.isPropertyAccessExpression(matchedFlagAccess.parent) &&
              matchedFlagAccess.parent.expression === matchedFlagAccess &&
              (matchedFlagAccess.parent.name.text === "value" ||
                matchedFlagAccess.parent.name.text === "enabled")
            ) {
              targetExpr = matchedFlagAccess.parent;
            }
            readCount += 1;
            if (!isWrappedInInlineFallback(targetExpr) && unprotectedReadLine === null) {
              unprotectedReadLine = getLineNumber(sourceFile, targetExpr);
            }
            return;
          }

          ts.forEachChild(n, visitScope);
        };
        visitScope(scope);

        if (readCount === 0 || unprotectedReadLine !== null) {
          unprotectedCalls.push({
            file: relFile,
            line: unprotectedReadLine ?? line,
            call: "useFlags",
            flagName,
            reason:
              readCount === 0
                ? "useFlags() flag has no fallback-guarded read"
                : "useFlags() flag property read has no inline fallback (?? / ||)",
          });
        }
      }
      return;
    }

    // Case C: inline/unassigned useFlags(["flag_a"]).flag_a.value
    for (const flagName of requestedFlags) {
      totalCalls += 1;
      let outerExpr = callNode;
      while (
        outerExpr.parent &&
        (ts.isPropertyAccessExpression(outerExpr.parent) ||
          ts.isElementAccessExpression(outerExpr.parent))
      ) {
        outerExpr = outerExpr.parent;
      }
      if (!isWrappedInInlineFallback(outerExpr)) {
        unprotectedCalls.push({
          file: relFile,
          line,
          call: "useFlags",
          flagName,
          reason: "useFlags() expression has no inline fallback (?? / ||)",
        });
      }
    }
  };

  const isTrackedCreationPosition = (node) => {
    let curr = node;
    while (
      curr.parent &&
      (ts.isParenthesizedExpression(curr.parent) ||
        ts.isAsExpression(curr.parent) ||
        ts.isTypeAssertionExpression(curr.parent) ||
        ts.isNonNullExpression(curr.parent) ||
        ts.isSatisfiesExpression(curr.parent))
    ) {
      curr = curr.parent;
    }
    const p = curr.parent;
    if (!p) return false;
    if (ts.isVariableDeclaration(p) && p.initializer === curr && ts.isIdentifier(p.name)) {
      return true;
    }
    if (
      ts.isPropertyDeclaration(p) &&
      p.initializer === curr &&
      getPropertyNameText(p.name) !== null
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === curr &&
      (ts.isIdentifier(p.left) ||
        (ts.isPropertyAccessExpression(p.left) &&
          p.left.expression.kind === ts.SyntaxKind.ThisKeyword))
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === curr) {
      return true;
    }
    return false;
  };

  // 3. Walk AST for inits, FlagsmithProvider, Flagsmith method calls, useFlags, and untracked instances
  const visit = (node) => {
    // Check untracked factory / constructor placement
    if (
      (ts.isCallExpression(node) && isFactoryCall(node)) ||
      (ts.isNewExpression(node) && isFlagsmithNewExpr(node))
    ) {
      if (!isTrackedCreationPosition(node)) {
        unverified.push({
          file: relFile,
          line: getLineNumber(sourceFile, node),
          kind: "untracked_instance",
          reason:
            "Flagsmith instance created in an untracked expression (store in a variable or class field)",
        });
      }
    }

    // A. `new Flagsmith({ ... })`
    if (ts.isNewExpression(node) && isFlagsmithNewExpr(node)) {
      totalInits += 1;
      const line = getLineNumber(sourceFile, node);
      const configArg = node.arguments?.[0];
      const defaultCheck = analyzeInitConfig(configArg, defaultsCtx);
      recordDefaultsOutcome(defaultCheck);

      if (defaultCheck.status === "unverified") {
        unverified.push({
          file: relFile,
          line,
          kind: "unverified_defaults",
          reason: defaultCheck.detail,
        });
      } else if (defaultCheck.status !== "ok") {
        unprotectedInits.push({
          file: relFile,
          line,
          init: "new Flagsmith()",
          reasons: [defaultCheck.status],
          reason:
            defaultCheck.status === "empty_defaults"
              ? "empty_defaults: defaultFlagHandler / offlineHandler is empty"
              : "missing_defaults: missing defaultFlagHandler / offlineHandler",
        });
      }
    }

    // B. `<FlagsmithProvider ...>`
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const isProvider =
        (ts.isIdentifier(tag) && providerNames.has(tag.text)) ||
        (ts.isPropertyAccessExpression(tag) &&
          ts.isIdentifier(tag.expression) &&
          flagsmithNamespaces.has(tag.expression.text) &&
          tag.name.text === "FlagsmithProvider");

      if (isProvider) {
        totalInits += 1;
        const line = getLineNumber(sourceFile, node);
        const outcomes = [];

        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
          const attrName = attr.name.text;
          if (attrName === "serverState" && ts.isJsxExpression(attr.initializer)) {
            outcomes.push(
              analyzeDefaultsExpr(
                attr.initializer.expression,
                "serverState",
                defaultsCtx
              )
            );
          } else if (attrName === "options" && ts.isJsxExpression(attr.initializer)) {
            outcomes.push(
              analyzeInitConfig(attr.initializer.expression, defaultsCtx)
            );
          }
        }

        const okOutcome = outcomes.find((o) => o.status === "ok");
        if (okOutcome) {
          recordDefaultsOutcome(okOutcome);
        } else {
          const unverifiedOutcome = outcomes.find((o) => o.status === "unverified");
          if (unverifiedOutcome) {
            unverified.push({
              file: relFile,
              line,
              kind: "unverified_defaults",
              reason: unverifiedOutcome.detail,
            });
          } else {
            const emptyOutcome = outcomes.find((o) => o.status === "empty_defaults");
            const code = emptyOutcome ? "empty_defaults" : "missing_defaults";
            unprotectedInits.push({
              file: relFile,
              line,
              init: "<FlagsmithProvider>",
              reasons: [code],
              reason:
                code === "empty_defaults"
                  ? "empty_defaults: <FlagsmithProvider> serverState/defaultFlags resolves to {}"
                  : "missing_defaults: missing serverState prop or options.defaultFlags / options.state",
            });
          }
        }
      }
    }

    // C. Call expressions
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // C1. `useFlags(...)`
      const isUseFlags =
        (ts.isIdentifier(callee) && useFlagsNames.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          flagsmithNamespaces.has(callee.expression.text) &&
          callee.name.text === "useFlags");

      if (isUseFlags) {
        analyzeUseFlagsCall(node);
      }

      // C2. `flagsmithObj.init(...)` or `flagsmithObj.<readMethod>(...)`
      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;
        const receiver = callee.expression;

        if (methodName === "init" && isFlagsmithReceiver(receiver)) {
          totalInits += 1;
          const line = getLineNumber(sourceFile, node);
          const configArg = node.arguments[0];
          const defaultCheck = analyzeInitConfig(configArg, defaultsCtx);
          const rejectionCheck = checkInitRejectionHandling(node);
          recordDefaultsOutcome(defaultCheck);

          if (defaultCheck.status === "unverified") {
            unverified.push({
              file: relFile,
              line,
              kind: "unverified_defaults",
              reason: defaultCheck.detail,
            });
          }

          const reasons = [];
          const messages = [];
          if (defaultCheck.status === "missing_defaults") {
            reasons.push("missing_defaults");
            messages.push("missing_defaults: missing defaultFlags or state in init() config");
          } else if (defaultCheck.status === "empty_defaults") {
            reasons.push("empty_defaults");
            messages.push("empty_defaults: defaultFlags resolves to an empty object {}");
          }

          if (!rejectionCheck.ok) {
            reasons.push(rejectionCheck.code);
            messages.push(rejectionCheck.reason);
          }

          if (reasons.length > 0) {
            unprotectedInits.push({
              file: relFile,
              line,
              init: `${receiver.getText(sourceFile)}.init()`,
              reasons,
              reason: messages.join("; "),
            });
          }
        } else if (FLAG_READ_METHODS.has(methodName) && isFlagsmithReceiver(receiver)) {
          totalCalls += 1;
          const line = getLineNumber(sourceFile, node);
          const flagName = getStringLiteralValue(node.arguments[0]);
          if (flagName === null) {
            unverified.push({
              file: relFile,
              line,
              kind: "dynamic_flag_key",
              reason: `${methodName}() uses a non-literal flag key; cannot verify offline snapshot coverage`,
            });
          } else {
            recordReferencedFlag(flagName, line, methodName);
          }

          if (BOOLEAN_FLAG_METHODS.has(methodName)) {
            return;
          }

          const hasFallback =
            isWrappedInInlineFallback(node) ||
            optionsHasExplicitFallback(node.arguments[1], localConstBindings) ||
            checkConstBindingAllUsesGuarded(node);

          if (!hasFallback) {
            unprotectedCalls.push({
              file: relFile,
              line,
              call: methodName,
              flagName,
              reason:
                "missing inline fallback (?? / ||) or explicit { fallback } option",
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (
    runtimeClientImportLine !== null &&
    totalInits === 0 &&
    totalCalls === 0 &&
    !exportsTrackedInstance &&
    unverified.length === 0
  ) {
    unverified.push({
      file: relFile,
      line: runtimeClientImportLine,
      kind: "untracked_import",
      reason:
        "Flagsmith client/hook is imported at runtime, but no SDK init or flag read could be tracked",
    });
  }

  return {
    totalInits,
    totalCalls,
    unprotectedInits,
    unprotectedCalls,
    referencedFlags,
    literalDefaultKeySets,
    hasDynamicDefaults,
    unverified,
  };
}

export function scanCodebase(dir) {
  const filePaths = collectSourceFiles(dir);
  const parsedFiles = filePaths.map((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(filePath)
    );
    return { filePath, sourceFile };
  });

  const projectIndex = buildProjectExportIndex(parsedFiles);
  const jsonCache = new Map();

  let totalInits = 0;
  let totalCalls = 0;
  const unprotectedInits = [];
  const unprotectedCalls = [];
  const referencedFlags = [];
  const literalDefaultKeySets = [];
  let hasDynamicDefaults = false;
  const unverified = [];

  for (const { filePath, sourceFile } of parsedFiles) {
    const res = scanSingleFile(filePath, sourceFile, projectIndex, jsonCache);
    totalInits += res.totalInits;
    totalCalls += res.totalCalls;
    unprotectedInits.push(...res.unprotectedInits);
    unprotectedCalls.push(...res.unprotectedCalls);
    referencedFlags.push(...res.referencedFlags);
    literalDefaultKeySets.push(...res.literalDefaultKeySets);
    if (res.hasDynamicDefaults) hasDynamicDefaults = true;
    unverified.push(...res.unverified);
  }

  return {
    scannedFiles: parsedFiles.length,
    totalInits,
    totalCalls,
    unprotectedInits,
    unprotectedCalls,
    referencedFlags,
    literalDefaultKeySets,
    hasDynamicDefaults,
    unverified,
  };
}

function getUniqueReferencedFlags(referencedFlags) {
  const seen = new Map();
  for (const ref of referencedFlags ?? []) {
    if (!seen.has(ref.name)) {
      seen.set(ref.name, ref);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function computeUncoveredFlags(scan, snapshot) {
  const snapFlags =
    snapshot?.flags && typeof snapshot.flags === "object"
      ? snapshot.flags
      : snapshot || {};
  const uniqueRefs = getUniqueReferencedFlags(scan.referencedFlags);
  const uncoveredFlags = [];

  const literalSets = scan.literalDefaultKeySets ?? [];
  const checkLiteralDefaults = literalSets.length > 0 && !scan.hasDynamicDefaults;

  for (const ref of uniqueRefs) {
    if (!Object.prototype.hasOwnProperty.call(snapFlags, ref.name)) {
      uncoveredFlags.push({
        name: ref.name,
        file: ref.file,
        line: ref.line,
        call: ref.call,
        reason: "missing_in_snapshot",
      });
    } else if (
      checkLiteralDefaults &&
      !literalSets.some((keySet) => keySet.has(ref.name))
    ) {
      uncoveredFlags.push({
        name: ref.name,
        file: ref.file,
        line: ref.line,
        call: ref.call,
        reason: "missing_in_default_flags",
      });
    }
  }

  return uncoveredFlags;
}

function computeUnknownFlags(scan, liveFlags) {
  const liveMap = new Set(liveFlags.map((f) => f.name));
  const uniqueRefs = getUniqueReferencedFlags(scan.referencedFlags);
  return uniqueRefs
    .filter((ref) => !liveMap.has(ref.name))
    .map((ref) => ({
      name: ref.name,
      file: ref.file,
      line: ref.line,
      call: ref.call,
    }));
}

function computeDrift(liveFlags, snapshot) {
  const snapFlags =
    snapshot?.flags && typeof snapshot.flags === "object"
      ? snapshot.flags
      : snapshot || {};
  const liveMap = new Map(liveFlags.map((f) => [f.name, f]));
  const drift = [];
  let inSync = 0;

  for (const item of liveFlags) {
    const local = snapFlags[item.name];
    const liveVal = normalizeValue(item.value);
    if (!local) {
      drift.push({
        name: item.name,
        status: "MISSING_IN_SNAPSHOT",
        live: { enabled: Boolean(item.enabled), value: liveVal },
        local: null,
      });
    } else {
      const localVal = normalizeValue(local.value);
      const isDrifted =
        Boolean(local.enabled) !== Boolean(item.enabled) || localVal !== liveVal;
      if (isDrifted) {
        drift.push({
          name: item.name,
          status: "DRIFTED",
          live: { enabled: Boolean(item.enabled), value: liveVal },
          local: { enabled: Boolean(local.enabled), value: localVal },
        });
      } else {
        inSync += 1;
      }
    }
  }

  for (const [name, local] of Object.entries(snapFlags)) {
    if (!liveMap.has(name) && local && typeof local === "object" && "enabled" in local) {
      drift.push({
        name,
        status: "STALE_IN_SNAPSHOT",
        live: null,
        local: { enabled: Boolean(local.enabled), value: normalizeValue(local.value) },
      });
    }
  }

  return { inSync, drift };
}

function runCli() {
  const resolvedSrc = path.resolve(process.cwd(), srcDir);
  if (!fs.existsSync(resolvedSrc)) {
    console.error(`Error: --src path does not exist: ${srcDir}`);
    process.exit(1);
  }

  const scan = scanCodebase(resolvedSrc);
  if (scan.scannedFiles === 0) {
    console.error(`Error: --src scanned 0 JS/TS source files: ${srcDir}`);
    process.exit(1);
  }

  let liveResult;
  try {
    liveResult = loadLiveFlags();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const snapshot = loadSnapshot(snapshotPath);
  const { inSync, drift } = computeDrift(liveResult.flags, snapshot);
  const uncoveredFlags = computeUncoveredFlags(scan, snapshot);
  const unknownFlags = computeUnknownFlags(scan, liveResult.flags);

  const report = {
    source: liveResult.source,
    snapshotPath: toPosixRelative(path.resolve(snapshotPath)),
    snapshotExists: Boolean(snapshot),
    summary: {
      liveFlags: liveResult.flags.length,
      inSync,
      drifted: drift.length,
      scannedFiles: scan.scannedFiles,
      totalInits: scan.totalInits,
      unprotectedInits: scan.unprotectedInits.length,
      totalCalls: scan.totalCalls,
      unprotectedCalls: scan.unprotectedCalls.length,
      uncoveredFlags: uncoveredFlags.length,
      unknownFlags: unknownFlags.length,
      unverified: scan.unverified.length,
    },
    drift,
    unprotectedInits: scan.unprotectedInits,
    unprotectedCalls: scan.unprotectedCalls,
    uncoveredFlags,
    unknownFlags,
    unverified: scan.unverified,
  };

  console.log(verboseOutput ? JSON.stringify(report, null, 2) : JSON.stringify(report));

  if (
    failOnFindings &&
    (drift.length > 0 ||
      scan.unprotectedInits.length > 0 ||
      scan.unprotectedCalls.length > 0 ||
      uncoveredFlags.length > 0 ||
      unknownFlags.length > 0 ||
      scan.unverified.length > 0)
  ) {
    process.exit(2);
  }
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runCli();
}
