# Troubleshooting & Rollback Reference

Read this file when a command in `SKILL.md` fails or when you need to roll back changes.

## Failure Recovery (Per Command)

| Command / Step | Failure Symptom | Recovery Action |
| :--- | :--- | :--- |
| `flagsmith` CLI missing | `command not found` / `ENOENT` | Install with `npm install -g @flagsmith/cli`, then re-run Step 1. |
| `audit-flags.sh` / `check-drift.mjs` | Exits `1` with `not logged in` or empty stdout | Run `flagsmith login` or set `FLAGSMITH_API_KEY`; verify `flagsmith.json` exists (`flagsmith init`). |
| `audit-flags.sh` / `check-drift.mjs` | 404 `/api/v1/api/v1/...` | Remove `/api/v1/` from `FLAGSMITH_API_URL` (base URL only, e.g., `https://api.flagsmith.com`). |
| `check-drift.mjs` | `--src path does not exist` or `scanned 0 JS/TS source files` | Pass the correct target source directory via `--src <path>`. |
| `check-drift.mjs` | `TypeScript compiler API (typescript) is required` | Install `typescript` in the target repo (`npm install -D typescript`) or inside the skill directory. |
| `git checkout -b` | Dirty working tree or branch already exists | Ask the developer whether to stash/commit existing edits or delete the existing branch (`git branch -D chore/flag-offline-shield-sync`). Never force-discard uncommitted user work. |
| `bake-snapshot.mjs` | Exits `1` (empty stdout, invalid JSON, or 0 flags) | Existing `public/flags.json` is untouched. Verify `FLAGSMITH_SDK_API_URL` (no `/api/v1/`), environment key, and that at least one flag exists. |
| `verify-outage.mjs` | Exits `1` listing `unprotectedInits` in `--src` | Patch every listed SDK init with `defaultFlags` / `state` / `serverState` / `defaultFlagHandler`, then re-run. |
| `verify-outage.mjs` | `flagsmith/isomorphic` not found or flag mismatch | Install `flagsmith` v9+ (`npm install flagsmith`) or re-bake `public/flags.json`; do not proceed to PR until `passed: true`. |
| `gh pr create` | Not logged in, missing remote, or PR already exists | Run `gh auth login`, verify `git remote -v`, or update the existing PR with `gh pr edit`. Never swallow errors with `|| true`. |

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
