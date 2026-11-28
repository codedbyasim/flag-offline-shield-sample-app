# Scanner & Outage Check Limitations

## AST Scanner (`scripts/check-drift.mjs`) — What It Does NOT Detect
- **Dynamic flag names:** Runtime-computed keys (e.g., `flagsmith.getValue(keyVar)` or template strings with expressions) are reported with `flagName: null`.
- **Untyped cross-file instances:** Flagsmith instances passed across files via untyped (`any`) parameters, dependency injection containers, or multi-hop re-export chains beyond direct exported instances and exported interfaces/types.
- **Indirect caller fallbacks:** Wrapper helpers like `function read() { return flagsmith.getValue("x"); }` where the nullish fallback (`??`) is applied by an outer caller in another function.
- **Cross-file init config objects:** Only inline object literals and same-file `const` object literals are inspected for `defaultFlags`, `state`, `serverState`, `defaultFlagHandler`, or `offlineHandler`.
- **Non-JS/TS SDKs:** Only `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files are scanned (not Python, Go, Java, Ruby, etc.).
- **Boolean intent on `hasFeature()`:** `hasFeature()` / `isFeatureEnabled()` always return a `boolean` (`false` when absent) so they are not flagged as unprotected; the scanner cannot know whether a specific feature should fail open (`{ fallback: true }`) vs. fail closed (`false`).
- **`init()` rejection handling gaps:**
  - Fire-and-forget `client.init({ defaultFlags });` statements (neither awaited nor returned and with no `.catch()`) are not flagged, even though they can trigger an `unhandledRejection` event in Node.
  - Promises stored in a variable and awaited/handled later (e.g., `const p = client.init({ defaultFlags }); await p;`) or passed to `Promise.all([...])` are not tracked across assignments.
  - Rejections handled in an outer caller of a function that returns `client.init(...)` are conservatively flagged at the `return` site.
  - Any `throw` statement inside a `catch` block (even conditional) is conservatively treated as rethrowing.
- **Semantic correctness:** Checks presence of offline defaults/fallbacks, not whether chosen fallback values are appropriate for business logic.

## Outage Check (`scripts/verify-outage.mjs`) — What Is NOT Covered
- Does not execute the target app's own runtime functions, React component tree, or business logic (pair with an app-level outage smoke test that invokes your own loader/component against `http://127.0.0.1:59999/api/v1/`).
- Does not test server-side Flagsmith SDKs (Node local evaluation, Python, Go, etc.) or browser `localStorage` caching.
- Does not verify semantic correctness of fallback values or runtime-computed flag keys.
