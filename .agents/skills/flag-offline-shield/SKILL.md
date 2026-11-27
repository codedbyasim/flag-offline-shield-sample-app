---
name: flag-offline-shield
description: Audits JS/TS repos for missing Flagsmith offline fallbacks and snapshot drift via low-token CLI --json --jq queries, bakes validated offline snapshots, patches SDK inits/calls, runs a standalone outage check, and opens a human-approved PR. Use when hardening Flagsmith integrations against API/network outages, syncing stale flags.json snapshots, or auditing repos for missing defaultFlags and fallbacks.
---
# Flag Offline Shield

Resolve `SKILL_DIR` to the folder containing this `SKILL.md`. All paths below are relative to `SKILL_DIR`; this skill has no dependency on any host repo's npm scripts or test runner.

## Dependencies
- `@flagsmith/cli` v2+ (`npm install -g @flagsmith/cli`), authenticated (`flagsmith login` or `FLAGSMITH_API_KEY`), bound via `flagsmith init` (`flagsmith.json`)
- Node.js 18+, `typescript` (for AST scan), `flagsmith` v9+ with `flagsmith/isomorphic` (for outage check)
- `git`, GitHub CLI `gh` (`gh auth login`), optional `bash` (only for `scripts/audit-flags.sh`)
- **URL rules:** `FLAGSMITH_API_URL` (`--api-url`) and `FLAGSMITH_SDK_API_URL` (`--sdk-api-url`, used by `eval`) take base URLs **without** `/api/v1/`. The JS SDK `api` option **requires** `/api/v1/`. Optional `FLAGSMITH_OUTAGE_TEST_URL` overrides `http://127.0.0.1:1/api/v1/`.

## Mandatory Safety & Token Rules
1. **Low-token CLI only:** Always run `flagsmith flag list --json --jq '[.[] | {name: .feature, enabled, value}]'` (or `scripts/audit-flags.sh` / `scripts/check-drift.mjs`). Never dump unfiltered CLI JSON into context.
2. **CLI v2.0.0 exit-0 guard:** The npm wrapper can exit `0` on failure. Never redirect `flagsmith eval --js > public/flags.json`. Always use `scripts/audit-flags.sh`, `scripts/check-drift.mjs`, and `scripts/bake-snapshot.mjs`, which validate stdout and exit non-zero on empty/invalid output.
3. **Two Human Approval Gates:** STOP at Gate #1 (before branching/editing) and Gate #2 (after showing full `git diff` and outage check results, before commit/push/PR).
4. **Never mutate live flags:** Never run `flag enable`, `flag disable`, or `flag update`.
5. **`environment document` security warning:** `flagsmith environment document` exports **server-side** data (segments, rules, server-only features). **NEVER commit its output to a public repo** or save it in `public/`. Keep it gitignored/private.

## Workflow

### 1. Audit (Live Flags + AST Scan)
```bash
bash "$SKILL_DIR/scripts/audit-flags.sh"
node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json
```
`check-drift.mjs` exits non-zero if `--src` is missing or scans 0 files, and outputs compact JSON (`summary`, `drift`, `unprotectedInits`, `unprotectedCalls`). `hasFeature()` / `isFeatureEnabled()` always return a `boolean` (`false` when absent) and are not flagged; pass `{ fallback: true }` only when a feature should fail open.

### 2. Impact Table
Present a concise table of every `drift` flag, `unprotectedInits` (`file:line`), and `unprotectedCalls` (`file:line`) with the planned fix.

### 3. Human Approval Gate #1 — STOP
Ask: **"Approve creating branch `chore/flag-offline-shield-sync`, baking `public/flags.json`, patching the listed SDK inits/calls, and running the outage check?"** Wait for explicit approval.

### 4. Branch
Verify clean git status (`git status --short`), then:
```bash
git checkout -b chore/flag-offline-shield-sync
```

### 5. Bake Validated Snapshot
```bash
node "$SKILL_DIR/scripts/bake-snapshot.mjs" --out ./public/flags.json
```

### 6. Patch Code
- Wire `defaultFlags` hydrated from `public/flags.json` (or `serverState` / `options.defaultFlags` on `<FlagsmithProvider>`) into every init in `unprotectedInits`, and catch `init()` rejections (`try { await client.init(...); } catch {}`) because `flagsmith/isomorphic` rejects on network failure even with `defaultFlags`.
- Add neutral inline fallbacks (`?? ""`, `?? 0`, or `{ fallback: ... }`) to every value-reading call in `unprotectedCalls`. Never write no-op `hasFeature(...) ?? false` (use `{ fallback: true }` only to fail open). Never hardcode fake promo copy.

### 7. Verify Outage Resilience & Re-Audit
```bash
node "$SKILL_DIR/scripts/verify-outage.mjs" --src ./src --snapshot ./public/flags.json
node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json
```
Confirm `verify-outage.mjs` returns `passed: true` (0 unprotected inits in `--src`, `SERVER` mock control, `DEFAULT_FLAGS` failover) and `check-drift.mjs` reports `drifted: 0`, `unprotectedInits: 0`, `unprotectedCalls: 0`. Also run the target repo's own typecheck and outage smoke tests if present.

### 8. Show Full Diff & Results
Show `git status --short`, full `git diff`, and the exact outputs/exit codes from Step 7.

### 9. Human Approval Gate #2 — STOP
Ask: **"Approve committing these changes, pushing `chore/flag-offline-shield-sync`, and opening the GitHub PR?"** Wait for explicit approval.

### 10. Commit, Push & Open PR
Write `pr-body.md` with real Markdown newlines (include before/after audit counts, real `verify-outage.mjs` output, and any app smoke test output). Never append `|| true` to `gh pr create`:
```bash
git add public/flags.json <patched-files>
git commit -m "chore(flags): sync offline defaults and harden Flagsmith fallbacks"
git push -u origin chore/flag-offline-shield-sync
gh pr create --title "chore(flags): sync offline defaults and harden Flagsmith fallbacks" --body-file pr-body.md
rm -f pr-body.md
```

## On-Demand References
- Command failures & rollback steps: read `references/troubleshooting-and-rollback.md`
- AST scanner & outage check boundaries: read `references/scanner-limitations.md`
