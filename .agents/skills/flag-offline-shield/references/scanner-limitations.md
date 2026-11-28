# Scanner & Outage Check Limitations

## AST Scanner (`scripts/check-drift.mjs`) — What It Does NOT Detect
- **Dynamic flag names:** Non-literal keys in `getValue(k)` / `hasFeature(k)` / `getFeatureValue(k)` / `isFeatureEnabled(k)` / `useFlags(list)` (or template strings with expressions) are reported with `flagName: null` and flagged under `unverified` (`kind: "dynamic_flag_key"`), causing `verify-outage.mjs` to fail rather than silently treating them as covered.
- **Untyped cross-file instances:** Flagsmith instances passed across files via untyped (`any`) parameters, dependency injection containers, or multi-hop re-export chains beyond direct exported instances and exported interfaces/types. When a file imports Flagsmith at runtime or creates an instance in an untracked position without any resolvable init/call, it is reported under `unverified` rather than silently treated as safe.
- **Indirect caller & early-return fallbacks:** Wrapper helpers like `function read() { return flagsmith.getValue("x"); }` where `??` is applied by an outer caller, as well as early-return null guards like `if (v === null) return ...;` before reading `v`, are still flagged as unprotected calls — use `??` (e.g., `v ?? ""`) instead. (Same-function `const v = client.getValue("x");` bindings where every use of `v` uses `??` / `||` / `if (v)` narrowing ARE accepted.)
- **Init `defaultFlags` resolution & `tsconfig` path aliases:** Inline object literals, same-file `const` objects/spreads, relative `.json` snapshot imports (validated on disk), relative same-project exported objects, and traceable same-file helpers/loops over `Object.entries(snapshot.flags)` are resolved. Importing the snapshot via a `tsconfig` path alias (e.g., `@/public/flags.json`), unresolvable function parameters (even if typed `IFlags`), external imports, or opaque helpers are reported under `unverified` — always use a relative path (e.g., `../public/flags.json`) for snapshot imports.
- **Non-JS/TS SDKs:** Only `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files are scanned (not Python, Go, Java, Ruby, etc.).
- **Boolean intent on `hasFeature()`:** `hasFeature()` / `isFeatureEnabled()` always return a `boolean` (`false` when absent) so they are not flagged as unprotected; the scanner cannot know whether a specific feature should fail open (`{ fallback: true }`) vs. fail closed (`false`).
- **Rejection handling boundaries:**
  - Awaited `init()`, returned `init()`, and fire-and-forget `init()` calls without `.catch()` or an enclosing non-rethrowing `try/catch` are flagged (`missing_rejection_handler`).
  - Rejections handled in an outer caller of a function that returns `client.init(...)` are conservatively flagged at the `return` site.
  - Any `throw` statement inside a `catch` block (even conditional) is conservatively treated as rethrowing.
- **Semantic correctness:** Checks presence and non-emptiness of offline defaults/fallbacks and literal flag coverage, not whether chosen fallback values are appropriate for business logic.

## Outage Check (`scripts/verify-outage.mjs`) — What Is NOT Covered
- Unless `--smoke "<command>"` is supplied (`appRuntime: "passed"`), `verify-outage.mjs` reports `appRuntime: "not_run"` and does not execute the target app's own runtime functions or React component tree.
- When `--smoke` is supplied, `appRuntime: "passed"` only means that the `--smoke` command (`smoke.command` in the report) exited `0` with `FLAGSMITH_OUTAGE_URL` set — the target repo's smoke test itself must actually exercise the `--src` code against `FLAGSMITH_OUTAGE_URL` and assert fallback behavior.
- Does not test server-side Flagsmith SDKs (Node local evaluation, Python, Go, etc.) or browser `localStorage` caching directly in the synthetic SDK harness.
- Does not verify semantic correctness of fallback values or runtime-computed flag keys.
