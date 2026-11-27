---
name: flag-offline-shield
description: Audits JS/TS repositories for missing Flagsmith offline fallbacks and snapshot drift using low-token CLI --json --jq queries, bakes validated offline default snapshots, patches unprotected SDK inits and calls, verifies outage resilience with a standalone check, and opens a human-approved GitHub PR. Use when hardening a Flagsmith-powered app against API or network outages, synchronizing stale local flag snapshots (flags.json), or reviewing a codebase for unprotected Flagsmith SDK usage.
---
# Flag Offline Shield

Portable, defensive-coding and offline-resilience workflow for Flagsmith-powered JS/TS applications.

All script paths below are **relative to this skill directory** (`SKILL_DIR` = the folder containing this `SKILL.md`, e.g., `.agents/skills/flag-offline-shield` or `skills/flag-offline-shield`). This skill has **no dependency** on any host repository's npm scripts or test runner.

## Dependencies & Prerequisites
Document and verify these before starting:
1. **Flagsmith CLI v2+:** `npm install -g @flagsmith/cli`
   - Repo bound to a Flagsmith project (`flagsmith init` -> `flagsmith.json`), or `--project` / `--environment` configured.
   - Authenticated via `flagsmith login` or `FLAGSMITH_API_KEY`.
2. **Node.js 18+** (required for `scripts/check-drift.mjs`, `scripts/bake-snapshot.mjs`, and `scripts/verify-outage.mjs`).
3. **`typescript` package** (required by `scripts/check-drift.mjs` AST scanner; resolved from the target repo's `node_modules` or the skill directory).
4. **`flagsmith` JS SDK v9+** exporting `flagsmith/isomorphic` (required by `scripts/verify-outage.mjs`; resolved from the target repo's `node_modules` or the skill directory).
5. **`git` and GitHub CLI (`gh`)** authenticated via `gh auth login` (for branching and PR creation).
6. **`bash`** (optional — only needed if invoking `scripts/audit-flags.sh`; `scripts/check-drift.mjs` works directly in Node on Windows, macOS, and Linux).

### API URL Environment Variables (Important)
- `FLAGSMITH_API_URL` (`--api-url`): Management API base URL **without** `/api/v1/` (default: `https://api.flagsmith.com`). Adding `/api/v1/` causes `/api/v1/api/v1/` 404 errors.
- `FLAGSMITH_SDK_API_URL` (`--sdk-api-url`): SDK API base URL **without** `/api/v1/` used by `flagsmith eval` (default: `https://edge.api.flagsmith.com`).
- JS SDK `api` option (in app code): **requires** `/api/v1/` (e.g., `https://edge.api.flagsmith.com/api/v1/`).
- `FLAGSMITH_OUTAGE_TEST_URL` (optional): Unreachable SDK endpoint for `scripts/verify-outage.mjs` (default: `http://127.0.0.1:1/api/v1/`).

## Strict Safety & Token Rules
1. **Low-Token CLI Queries (Mandatory):** Always use `flagsmith flag list --json --jq '[.[] | {name: .feature, enabled, value}]'` (or `scripts/audit-flags.sh` / `scripts/check-drift.mjs`). Never dump unfiltered Flagsmith API JSON into agent context.
2. **CLI v2.0.0 Exit-0 Guard:** The `@flagsmith/cli` v2.0.0 npm wrapper can exit `0` even when the underlying binary fails. Never trust exit code `0` alone and **never** redirect `flagsmith eval --js > public/flags.json` directly. Always use the bundled scripts (`scripts/audit-flags.sh`, `scripts/check-drift.mjs`, `scripts/bake-snapshot.mjs`), which validate stdout and exit non-zero on empty, non-JSON, or wrong-shape output.
3. **Two Mandatory Human Approval Gates:**
   - **Gate 1 (before any mutation):** Present the Audit Impact Table and STOP until the developer explicitly approves branching, baking, and patching.
   - **Gate 2 (before commit/push/PR):** Show the full `git diff` and outage verification results and STOP until the developer explicitly approves committing, pushing, and opening the PR.
4. **Never Mutate Live Production Flags:** Do not run `flagsmith flag enable`, `flagsmith flag disable`, or `flagsmith flag update`. This skill only hardens local code and offline defaults.
5. **Server-Side `environment document` Security Warning:**
   > **WARNING:** `flagsmith environment document` outputs **server-side** environment data (including segments, rules, server-only features, and internal metadata). **NEVER commit `environment document` output to a public repository** or place it under `public/`. For server-side local evaluation, store it only in gitignored/private deployment storage or secret managers and verify `.gitignore` excludes it before any `git add`.

---

## Step-by-Step Workflow

Set `SKILL_DIR` to the directory containing this `SKILL.md`.

### Step 1: Audit (Live Flags + AST Codebase Scan)
1. Optional standalone minimal flag inventory (only `{name, enabled, value}`):
   ```bash
   bash "$SKILL_DIR/scripts/audit-flags.sh"
   ```
   Under the hood this executes:
   ```bash
   flagsmith flag list --json --jq '[.[] | {name: .feature, enabled, value}]'
   ```
2. Run the compact TypeScript AST drift and fallback scanner against the target repo:
   ```bash
   node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json
   ```
   *(Adjust `--src` and `--snapshot` to match the target repository layout. Pass `--live-file <path>` only for offline fixture testing.)*

The JSON output contains `summary` plus **only problem rows** (no duplicated arrays):
- `drift`: flags that are `DRIFTED`, `MISSING_IN_SNAPSHOT`, or `STALE_IN_SNAPSHOT`
- `unprotectedInits`: SDK inits (`flagsmith.init()`, `createFlagsmithInstance().init()`, `<FlagsmithProvider>`, `new Flagsmith()`) missing `defaultFlags` / `state` / `serverState` / `defaultFlagHandler` / `offlineHandler`
- `unprotectedCalls`: Flagsmith-owned `hasFeature`, `getValue`, `isFeatureEnabled`, `getFeatureValue`, and `useFlags` calls missing an inline fallback (`??`, `||`, ternary) or explicit `{ fallback }` option.

#### Scanner Limitations (What It Does NOT Detect)
- Dynamic flag names computed at runtime (e.g., `flagsmith.getValue(keyVar)` — reported with `flagName: null`).
- Flagsmith instances passed across files via untyped (`any`) parameters, DI containers, or multi-hop re-exports beyond direct exported instances/types.
- Fallbacks applied indirectly in an outer caller of a wrapper function.
- Init config objects imported from another file (only inline object literals and same-file `const` object literals are inspected).
- Non-JS/TS SDKs (Python, Go, Java, Ruby, etc.).
- Whether a fallback value is semantically right for your business logic.

---

### Step 2: Present the Audit Impact Table
Present a concise **Impact Table** summarizing the findings from Step 1:

| Category | Location / Flag | Current State | Proposed Fix |
| :--- | :--- | :--- | :--- |
| Snapshot Drift | `<flag_name>` | Live vs. Local | Bake fresh `public/flags.json` |
| Unprotected Init | `<file:line>` | Missing `defaultFlags` / `serverState` | Hydrate `defaultFlags` from `public/flags.json` |
| Unprotected Call | `<file:line>` | `<method>(<flag>)` without fallback | Add neutral inline fallback (`??` or `{ fallback }`) |

---

### Step 3: Human Approval Gate #1 (Before Any Mutation)
Ask explicitly:
> **"Approve creating branch `chore/flag-offline-shield-sync`, baking `public/flags.json`, patching the listed SDK inits/calls, and running the outage check?"**

**STOP** and wait for explicit developer approval. Do not touch git or any file before confirmation.

---

### Step 4: Create a Dedicated Branch
Verify the working tree is clean (`git status --short`), then branch from the current base branch:
```bash
git checkout -b chore/flag-offline-shield-sync
```

---

### Step 5: Bake Validated Offline Snapshot
Run the bundled atomic snapshot baker (validates JSON and non-empty `flags` before replacing the target file):
```bash
node "$SKILL_DIR/scripts/bake-snapshot.mjs" --out ./public/flags.json
```
*(Reminder: do **not** run `flagsmith environment document` into a committed file in a public repository.)*

---

### Step 6: Patch Unprotected SDK Inits & Call Sites
1. Wire `defaultFlags` (or `serverState` on `<FlagsmithProvider>`) hydrated from the baked `public/flags.json` into every init reported in `unprotectedInits`.
2. Add safe, neutral inline fallbacks (`?? false`, `?? ""`, `?? 0`, or Flagsmith's explicit `{ fallback: ... }` option) to every call reported in `unprotectedCalls`. Never hardcode promo copy or fake success states that hide the real SDK defaults.

---

### Step 7: Run Standalone Outage Check & Re-Audit
1. Run the bundled standalone outage verification script:
   ```bash
   node "$SKILL_DIR/scripts/verify-outage.mjs" --snapshot ./public/flags.json
   ```
   Confirm `passed: true`:
   - Positive control hits a local mock SDK HTTP server (`sdkSource: "SERVER"`) and returns server values.
   - Unreachable endpoint (`http://127.0.0.1:1/api/v1/`) triggers a real network error (`sdkSource: "NONE"` unprotected vs. `sdkSource: "DEFAULT_FLAGS"` shielded returning every baked flag value).
2. Re-run the AST scanner to confirm zero remaining problems:
   ```bash
   node "$SKILL_DIR/scripts/check-drift.mjs" --src ./src --snapshot ./public/flags.json
   ```
   Verify `summary.drifted === 0`, `summary.unprotectedInits === 0`, and `summary.unprotectedCalls === 0`.
3. If the target repository defines its own typecheck or test command (e.g., `npx tsc --noEmit`), run it too so patches compile cleanly.

---

### Step 8: Show Full Diff & Verification Results
Show the developer:
```bash
git status --short
git diff
```
Alongside the exact outputs and exit statuses of `bake-snapshot.mjs`, `verify-outage.mjs`, and the post-patch `check-drift.mjs` run.

---

### Step 9: Human Approval Gate #2 (Before Commit, Push & PR)
Ask explicitly:
> **"Approve committing these changes, pushing `chore/flag-offline-shield-sync`, and opening the GitHub PR?"**

**STOP** and wait for explicit developer confirmation.

---

### Step 10: Commit, Push & Open Pull Request
Write the PR body to a temporary file with real Markdown newlines (never escaped `\n` strings, and never append `|| true` to `gh pr create`):
```bash
git add public/flags.json <patched-source-files>
git commit -m "chore(flags): sync offline defaults and harden Flagsmith fallbacks"
git push -u origin chore/flag-offline-shield-sync
gh pr create \
  --title "chore(flags): sync offline defaults and harden Flagsmith fallbacks" \
  --body-file pr-body.md
rm -f pr-body.md
```
Include in `pr-body.md`:
- Audit Impact & Drift Summary (before vs. after)
- Exact `verify-outage.mjs` positive control + outage test result
- Note that both human approval gates were confirmed before mutation and PR creation.

---

## Failure Recovery (What to Do When Each Command Fails)

| Command / Step | Failure Symptom | Recovery Action |
| :--- | :--- | :--- |
| `flagsmith` CLI missing | `command not found` / `ENOENT` | Install with `npm install -g @flagsmith/cli`, then re-run Step 1. |
| `audit-flags.sh` / `check-drift.mjs` | Exits `1` with `not logged in` or empty stdout | Run `flagsmith login` or set `FLAGSMITH_API_KEY`; verify `flagsmith.json` exists (`flagsmith init`). |
| `audit-flags.sh` / `check-drift.mjs` | 404 `/api/v1/api/v1/...` | Remove `/api/v1/` from `FLAGSMITH_API_URL` (base URL only, e.g., `https://api.flagsmith.com`). |
| `check-drift.mjs` | `TypeScript compiler API (typescript) is required` | Install `typescript` in the target repo (`npm install -D typescript`) or inside the skill directory. |
| `git checkout -b` | Dirty working tree or branch already exists | Ask the developer whether to stash/commit existing edits or reuse/delete the existing branch (`git branch -D chore/flag-offline-shield-sync`). Never force-discard uncommitted user work. |
| `bake-snapshot.mjs` | Exits `1` (empty stdout, invalid JSON, or 0 flags) | Existing `public/flags.json` is untouched. Verify `FLAGSMITH_SDK_API_URL` (no `/api/v1/`), environment key, and that at least one flag exists in the environment. |
| `verify-outage.mjs` | `flagsmith/isomorphic` not found or assertion fails | Install `flagsmith` v9+ (`npm install flagsmith`) or inspect the failing flag mismatch in `public/flags.json`; do not proceed to PR until `passed: true`. |
| `gh pr create` | Not logged in, missing remote, or PR already exists | Run `gh auth login`, verify `git remote -v`, or update the existing PR with `gh pr edit`. Never swallow errors with `|| true`. |

---

## Rollback Steps
- **Before commit (discard local edits on the branch):**
  ```bash
  git checkout -- public/flags.json src/
  git checkout -
  git branch -D chore/flag-offline-shield-sync
  ```
- **After local commit (before push):**
  ```bash
  git checkout -
  git branch -D chore/flag-offline-shield-sync
  ```
- **After push / PR opened:**
  ```bash
  gh pr close chore/flag-offline-shield-sync --delete-branch
  ```
