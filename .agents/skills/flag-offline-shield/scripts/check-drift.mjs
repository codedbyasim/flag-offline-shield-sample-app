#!/usr/bin/env node
/**
 * check-drift.mjs
 * Low-token Flagsmith offline snapshot drift detector + TypeScript AST fallback & init scanner.
 *
 * Outputs compact JSON: summary + ONLY problem rows (drift, unprotectedInits, unprotectedCalls),
 * with zero duplicated arrays.
 *
 * AST Scanner Limitations (what it does NOT detect):
 *   - Dynamic flag names computed at runtime (reported with flagName: null).
 *   - Flagsmith instances passed across files via untyped (`any`) params, DI containers,
 *     or multi-hop re-export chains beyond direct exported instances/types.
 *   - Fallbacks applied indirectly in an outer caller of a wrapper function.
 *   - Config/options objects imported from another file (only inline object literals and
 *     same-file `const` object literals are inspected for defaultFlags/state/defaultFlagHandler).
 *   - Non-JS/TS SDKs (Python, Go, Java, Ruby, etc.).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

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
const jqExpr = "[.[] | {name: .feature, enabled, value}]";

const FLAGSMITH_MODULE_RE = /^(@flagsmith\/)?flagsmith(\/|$)|^flagsmith-nodejs$/;
const FLAGSMITH_TYPE_NAMES = new Set(["IFlagsmith", "Flagsmith"]);
const FLAG_READ_METHODS = new Set([
  "hasFeature",
  "getValue",
  "isFeatureEnabled",
  "getFeatureValue",
]);
const OFFLINE_DEFAULT_KEYS = new Set([
  "defaultFlags",
  "state",
  "serverState",
  "defaultFlagHandler",
  "default_flag_handler",
  "offlineHandler",
]);
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

function isNonEmptyMeaningfulExpr(expr) {
  if (!expr) return false;
  const unwrapped = unwrapExpr(expr);
  if (
    unwrapped.kind === ts.SyntaxKind.UndefinedKeyword ||
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return false;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    return false;
  }
  if (ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length === 0) {
    return false;
  }
  return true;
}

function resolveObjectLiteral(expr, localConstObjects) {
  if (!expr) return null;
  const unwrapped = unwrapExpr(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped;
  }
  if (ts.isIdentifier(unwrapped) && localConstObjects.has(unwrapped.text)) {
    return localConstObjects.get(unwrapped.text);
  }
  return null;
}

function objectHasOfflineDefaults(expr, localConstObjects) {
  const obj = resolveObjectLiteral(expr, localConstObjects);
  if (!obj) return false;
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (OFFLINE_DEFAULT_KEYS.has(prop.name.text)) {
        return true;
      }
    } else if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyNameText(prop.name);
      if (key && OFFLINE_DEFAULT_KEYS.has(key)) {
        if (isNonEmptyMeaningfulExpr(prop.initializer)) {
          return true;
        }
      }
    }
  }
  return false;
}

function optionsHasExplicitFallback(expr, localConstObjects) {
  const obj = resolveObjectLiteral(expr, localConstObjects);
  if (!obj) return false;
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "fallback") {
      return true;
    }
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyNameText(prop.name);
      if (key === "fallback") {
        const init = unwrapExpr(prop.initializer);
        if (
          init.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isIdentifier(init) && init.text === "undefined")
        ) {
          return true;
        }
      }
    }
  }
  return false;
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

/**
 * Pass 1: Collect exported interfaces/types containing Flagsmith instance properties
 * and exported Flagsmith instance variable names across all source files.
 */
function buildProjectExportIndex(parsedFiles) {
  const exportedContainerTypes = new Map(); // typeName -> Set<propName>
  const exportedInstanceNames = new Set();

  for (const { sourceFile } of parsedFiles) {
    const localFactories = new Set();
    const localClasses = new Set();
    const localInstances = new Set();

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        if (!FLAGSMITH_MODULE_RE.test(stmt.moduleSpecifier.text)) continue;
        const clause = stmt.importClause;
        if (!clause) continue;
        if (clause.name) localInstances.add(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            const local = el.name.text;
            if (imported === "createFlagsmithInstance" || imported === "useFlagsmith") {
              localFactories.add(local);
            } else if (imported === "Flagsmith") {
              localClasses.add(local);
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
      }
    }
  }

  return { exportedContainerTypes, exportedInstanceNames };
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

function scanSingleFile(filePath, sourceFile, projectIndex) {
  const relFile = toPosixRelative(filePath);

  const flagsmithNamespaces = new Set();
  const flagsmithInstances = new Set();
  const flagsmithThisProps = new Set();
  const instanceFactories = new Set();
  const flagsmithClasses = new Set();
  const providerNames = new Set();
  const useFlagsNames = new Set();
  const localConstObjects = new Map();
  const typedVars = new Map(); // varName -> typeName
  const localInterfaces = collectInterfacePropertyTypes(sourceFile);
  const containerTypes = new Map(projectIndex.exportedContainerTypes);

  // Add same-file interfaces that directly contain an IFlagsmith/Flagsmith property
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

  // 1. Collect ES imports & CommonJS requires
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const mod = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) continue;

      if (FLAGSMITH_MODULE_RE.test(mod)) {
        if (clause.name) {
          if (mod === "flagsmith-nodejs") {
            flagsmithClasses.add(clause.name.text);
          } else {
            flagsmithInstances.add(clause.name.text);
          }
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            flagsmithNamespaces.add(clause.namedBindings.name.text);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              const imported = el.propertyName ? el.propertyName.text : el.name.text;
              const local = el.name.text;
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
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
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

  // 2. Collect same-file const objects, require() calls, factory instances, and typed vars/params
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

  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (node.type) {
        recordTypedBinding(node.name, node.type);
      }

      if (node.initializer) {
        const init = unwrapExpr(node.initializer);

        // CommonJS require("flagsmith*")
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          init.arguments.length === 1
        ) {
          const mod = getStringLiteralValue(init.arguments[0]);
          if (mod && FLAGSMITH_MODULE_RE.test(mod)) {
            if (ts.isIdentifier(node.name)) {
              if (mod === "flagsmith-nodejs") {
                flagsmithClasses.add(node.name.text);
              } else {
                flagsmithInstances.add(node.name.text);
              }
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                if (!ts.isIdentifier(el.name)) continue;
                const imported = el.propertyName
                  ? getPropertyNameText(el.propertyName)
                  : el.name.text;
                const local = el.name.text;
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
          }
        }

        if (ts.isIdentifier(node.name)) {
          if (ts.isObjectLiteralExpression(init)) {
            localConstObjects.set(node.name.text, init);
          }
          if (isFactoryCall(init) || isFlagsmithNewExpr(init)) {
            flagsmithInstances.add(node.name.text);
          }
        }
      }
    }

    // Track `client = createFlagsmithInstance()` or `this.client = createFlagsmithInstance()`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (isFactoryCall(node.right) || isFlagsmithNewExpr(node.right)) {
        if (ts.isIdentifier(node.left)) {
          flagsmithInstances.add(node.left.text);
        } else if (
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          flagsmithThisProps.add(node.left.name.text);
        }
      }
    }

    if (ts.isParameter(node) && node.type) {
      recordTypedBinding(node.name, node.type);
    }

    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

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
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const obj = unwrapExpr(unwrapped.expression);
      const prop = unwrapped.name.text;

      // this.flagsmithClient
      if (
        obj.kind === ts.SyntaxKind.ThisKeyword &&
        flagsmithThisProps.has(prop)
      ) {
        return true;
      }
      // FlagsmithNS.default
      if (
        ts.isIdentifier(obj) &&
        flagsmithNamespaces.has(obj.text) &&
        prop === "default"
      ) {
        return true;
      }
      // evalResult.instance where evalResult: SdkEvalResult and SdkEvalResult.instance: IFlagsmith
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

  let totalInits = 0;
  let totalCalls = 0;
  const unprotectedInits = [];
  const unprotectedCalls = [];

  const analyzeUseFlagsCall = (callNode) => {
    const line = getLineNumber(sourceFile, callNode);
    const firstArg = callNode.arguments[0] ? unwrapExpr(callNode.arguments[0]) : null;
    const requestedFlags = [];

    if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
      for (const el of firstArg.elements) {
        const name = getStringLiteralValue(el);
        if (name) requestedFlags.push(name);
      }
    }

    const parent = callNode.parent;

    // If flag list is dynamic / empty, inspect outer fallback directly
    if (requestedFlags.length === 0) {
      totalCalls += 1;
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

          // Match flags.flagName or flags["flagName"]
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

  // 3. Walk AST for inits, FlagsmithProvider, Flagsmith method calls, and useFlags
  const visit = (node) => {
    // A. `new Flagsmith({ ... })`
    if (ts.isNewExpression(node) && isFlagsmithNewExpr(node)) {
      totalInits += 1;
      const configArg = node.arguments?.[0];
      const hasDefaults = objectHasOfflineDefaults(configArg, localConstObjects);
      if (!hasDefaults) {
        unprotectedInits.push({
          file: relFile,
          line: getLineNumber(sourceFile, node),
          init: "new Flagsmith()",
          reason: "missing defaultFlagHandler / offlineHandler",
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
        let hasDefaults = false;

        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const attrName = attr.name.text;
          if (attrName === "serverState" && attr.initializer) {
            if (
              ts.isJsxExpression(attr.initializer) &&
              isNonEmptyMeaningfulExpr(attr.initializer.expression)
            ) {
              hasDefaults = true;
            }
          } else if (attrName === "options" && attr.initializer) {
            if (
              ts.isJsxExpression(attr.initializer) &&
              objectHasOfflineDefaults(attr.initializer.expression, localConstObjects)
            ) {
              hasDefaults = true;
            }
          }
        }

        if (!hasDefaults) {
          unprotectedInits.push({
            file: relFile,
            line: getLineNumber(sourceFile, node),
            init: "<FlagsmithProvider>",
            reason: "missing serverState prop or options.defaultFlags / options.state",
          });
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
          const configArg = node.arguments[0];
          const hasDefaults = objectHasOfflineDefaults(configArg, localConstObjects);
          if (!hasDefaults) {
            unprotectedInits.push({
              file: relFile,
              line: getLineNumber(sourceFile, node),
              init: `${receiver.getText(sourceFile)}.init()`,
              reason: "missing defaultFlags or state in init() config",
            });
          }
        } else if (FLAG_READ_METHODS.has(methodName) && isFlagsmithReceiver(receiver)) {
          totalCalls += 1;
          const flagName = getStringLiteralValue(node.arguments[0]);
          const hasFallback =
            isWrappedInInlineFallback(node) ||
            optionsHasExplicitFallback(node.arguments[1], localConstObjects);

          if (!hasFallback) {
            unprotectedCalls.push({
              file: relFile,
              line: getLineNumber(sourceFile, node),
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

  return { totalInits, totalCalls, unprotectedInits, unprotectedCalls };
}

function scanCodebase(dir) {
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

  let totalInits = 0;
  let totalCalls = 0;
  const unprotectedInits = [];
  const unprotectedCalls = [];

  for (const { filePath, sourceFile } of parsedFiles) {
    const res = scanSingleFile(filePath, sourceFile, projectIndex);
    totalInits += res.totalInits;
    totalCalls += res.totalCalls;
    unprotectedInits.push(...res.unprotectedInits);
    unprotectedCalls.push(...res.unprotectedCalls);
  }

  return {
    scannedFiles: parsedFiles.length,
    totalInits,
    totalCalls,
    unprotectedInits,
    unprotectedCalls,
  };
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

let liveResult;
try {
  liveResult = loadLiveFlags();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const snapshot = loadSnapshot(snapshotPath);
const scan = scanCodebase(srcDir);
const { inSync, drift } = computeDrift(liveResult.flags, snapshot);

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
  },
  drift,
  unprotectedInits: scan.unprotectedInits,
  unprotectedCalls: scan.unprotectedCalls,
};

console.log(JSON.stringify(report, null, 2));
