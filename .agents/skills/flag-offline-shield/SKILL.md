---
name: flag-offline-shield
description: Audits JS/TS repos for missing Flagsmith offline fallbacks and snapshot drift via low-token CLI --json --jq queries, bakes validated offline snapshots, patches SDK inits/calls, runs a standalone outage check, and opens a human-approved PR. Use when hardening Flagsmith integrations against API/network outages, syncing stale flags.json snapshots, or auditing repos for missing defaultFlags and fallbacks.
---
# Flag Offline Shield

Resolve `SKILL_DIR` to the folder containing this `SKILL.md`. All paths below are relative to `SKILL_DIR`; no dependency on host npm scripts.

## Dependencies
- `@flagsmith/cli` v2+ (`npm install -g @flagsmith/cli`), authenticated (`flagsmith login` or `FLAGSMITH_API_KEY`), bound via `flagsmith init` (`flagsmith.json`)
- Node.js 18+, `typescript` (AST scan), `flagsmith` v9+ with `flagsmith/isomorphic` (outage check)
- `git`, `gh` (`gh auth login`), optional `bash` (standalone `scripts/audit-flags.sh`)
- **URL rules:** `FLAGSMITH_API_URL` (`--api-url`) and `FLAGSMITH_SDK_API_URL` (`--sdk-api-url`, for `eval`) omit `/api/v1/`. JS SDK `api` requires `/api/v1/`. `verify-outage.mjs` sets `FLAGSMITH_OUTAGE_URL=http://127.0.0.1:59999/api/v1/`.

## Mandatory Safety & Token Rules
1. **Low-token CLI:** `scripts/check-drift.mjs` (and `scripts/audit-flags.sh`) run `flagsmith flag list --json --jq '[.[] | {name: .feature, enabled, value}]'` and emit single-line JSON. Never dump unfiltered JSON.
2. **CLI v2.0.0 exit-0 guard:** The npm wrapper can exit `0` on failure. Never redirect `flagsmith eval --js > public/flags.json`. Always use bundled scripts, which validate stdout and exit non-zero on invalid output.
3. **Two Human Approval Gates:** STOP at Gate #1 (before branching/editing) and Gate #2 (after showing full `git diff` and verification results, before commit/push/PR).
4. **Read-only on live flags:** Never run `flag enable`, `flag disable`, `flag update`, or `flag delete`.
5. **`environment document` warning:** Exports server-side data (segments, rules, server-only flags). **NEVER commit** its output to a public repo or `public/`.

## Workflow

### 1. Audit (Live Flags + AST Scan)
```bash
node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json
```
Runs `flagsmith flag list --json --jq ...` and scans `--src` in one call. Exits non-zero if `--src` is missing or has 0 files (exit `2` on findings with `--fail-on-findings`). Reports `summary`, `drift`, `unprotectedInits` (`reasons`: `missing_defaults`, `empty_defaults`, `missing_rejection_handler`), `unprotectedCalls`, `uncoveredFlags`, `unknownFlags`, and `unverified`. `hasFeature()`/`isFeatureEnabled()` return `boolean`; pass `{ fallback: true }` only to fail open.

### 2. Impact Table
Show a concise table of `drift`, `unprotectedInits` (`file:line` + `reasons`), `unprotectedCalls` (`file:line`), `uncoveredFlags`, `unknownFlags`, and `unverified` with planned fixes.

### 3. Human Approval Gate #1 — STOP
Ask: **"Approve creating branch `chore/flag-offline-shield-sync`, baking `public/flags.json`, patching the listed SDK inits/calls, and running the outage check?"** Wait for explicit approval.

### 4. Branch
Verify clean `git status --short`, then:
```bash
git checkout -b chore/flag-offline-shield-sync
```

### 5. Bake Validated Snapshot
```bash
node "$SKILL_DIR/scripts/bake-snapshot.mjs" --out ./public/flags.json
```

### 6. Patch Code
- Recommended verified pattern: import `snapshot` from `../public/flags.json` and pass `defaultFlags: snapshot.flags` (or a same-file helper mapping `Object.entries(snapshot.flags)` if `IFlags` needs numeric `id`) or `<FlagsmithProvider options={{ defaultFlags: snapshot.flags }}>`. Do not pass `defaultFlags` as an unresolvable parameter or opaque helper (reported as `unverified`).
- Catch `init()` rejections (`try { await client.init(...); } catch {}` or `.catch(() => {})`), as `flagsmith/isomorphic` rejects on network failure even with `defaultFlags`.
- Add neutral inline fallbacks (`?? ""`, `?? 0`, or `{ fallback: ... }`) to `unprotectedCalls`. Never write no-op `hasFeature(...) ?? false` or fake promo copy.
- Ensure all literal flags read in code exist in `public/flags.json`, and resolve any `unknownFlags` or `unverified` items.

### 7. Verify Outage Resilience & Re-Audit
```bash
node "$SKILL_DIR/scripts/verify-outage.mjs" --src ./src --snapshot ./public/flags.json --smoke "npm test"
node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json --fail-on-findings
```
Omit `--smoke` if the repo has no outage test (`appRuntime: "not_run"`; `--verbose` adds `notCovered`). When `--smoke` runs, the report includes `smoke.command`; `appRuntime: "passed"` only means that command exited `0` (pair `--src` with a test exercising the same code against `FLAGSMITH_OUTAGE_URL`). Confirm `passed: true`, `sdkAndStaticCheck: "passed"`, and `check-drift.mjs --fail-on-findings` exits `0`. Run typecheck/lint if present.

### 8. Show Full Diff & Results
Show `git status --short`, full `git diff`, and exact outputs/exit codes from Step 7.

### 9. Human Approval Gate #2 — STOP
Ask: **"Approve committing these changes, pushing `chore/flag-offline-shield-sync`, and opening the GitHub PR?"** Wait for explicit approval.

### 10. Commit, Push & Open PR
Write `pr-body.md` with before/after counts, `verify-outage.mjs` output (`sdkAndStaticCheck`/`appRuntime`), and smoke output. Never append `|| true` to `gh pr create`:
```bash
git add public/flags.json <patched-files>
git commit -m "chore(flags): sync offline defaults and harden Flagsmith fallbacks"
git push -u origin chore/flag-offline-shield-sync
gh pr create --title "chore(flags): sync offline defaults and harden Flagsmith fallbacks" --body-file pr-body.md
rm -f pr-body.md
```

## On-Demand References
- Command failures & rollback: `references/troubleshooting-and-rollback.md`
- Scanner & outage boundaries: `references/scanner-limitations.md`
