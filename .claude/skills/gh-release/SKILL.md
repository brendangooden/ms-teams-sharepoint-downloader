---
name: gh-release
description: Cut a GitHub release for the Chrome extension — pre-flight checks, package zip, bump demo-website version refs, draft release notes with commit attribution, tag, push, create GH release with zip attached, and optionally upload to the Chrome Web Store. Also handles publishing a previously-created draft via publish-release.ps1 (with optional CWS upload). Use when user says "release", "ship a release", "cut v1.4.x", "make a GH release", "publish the draft", or asks to publish a new extension version.
---

# gh-release

Cut a tagged GitHub release for `releases/ms-teams-downloader-v<version>.zip`. CWS upload is opt-in via `--cws-publish` (requires one-time OAuth setup).

## Quick start

```pwsh
# User has bumped src/manifest.json "version" and committed it
pwsh .claude/skills/gh-release/scripts/preflight.ps1
# Read output, fix any blockers, then proceed through the workflow below
```

## Inputs / flags

Honour these if the user mentions them in the invocation:

- `--publish` — publish GH release immediately instead of draft (default: draft).
- `--include-docs` — include `docs(*)`, `chore(*)`, and `demo-website/`-only commits in release notes.
- `--ignore-stale-refs` — skip the auto-bump of `demo-website/` version refs.
- `--from <sha-or-tag>` — override the commit range start for notes (default: last release tag, or auto-detected previous version-bump commit).
- `--credit-all` — credit the repo owner in release notes too (default: only non-owner contributors get `by @login` appended).
- `--no-attribution` — disable `by @login` attribution entirely.
- `--cws-publish` — after the GH release succeeds, upload the zip to the Chrome Web Store as a draft. Requires `releases/cws-publish.env` populated; see "CWS publish setup" below.
- `--cws-submit` — implies `--cws-publish`, additionally submits for review (i.e. publishes to the public). Use sparingly — once submitted, Google's review queue is hours-to-days.
- `--cws-target trustedTesters` — when used with `--cws-submit`, targets the trusted-testers track instead of public.

## Workflow

### 1. Pre-flight (run `scripts/preflight.ps1`)

The script emits JSON with the keys below. If `blocking_issues` is non-empty, STOP and report to the user — do NOT proceed.

- `version` — from `src/manifest.json`.
- `tag` — `v<version>`.
- `branch` — current branch.
- `clean_tree` — boolean.
- `in_sync_with_origin` — boolean.
- `tag_exists_local` / `tag_exists_remote` — booleans.
- `release_exists` — boolean (via `gh release view`).
- `last_tag` — most recent prior tag, or null (bootstrap case).
- `range_start` — SHA to start commit-range from for notes.
- `commits_in_range` — count.
- `stale_version_refs` — list of `{path, line, content}` outside `src/manifest.json` and `package-lock.json` files.
- `zip_path` — `ms-teams-downloader-v<version>.zip` at repo root (may or may not exist yet).
- `blocking_issues` — array of strings.

**Blockers** (any of these → abort):
- not on `main`
- working tree dirty
- behind/ahead of `origin/main`
- tag `v<version>` already exists (local or remote)
- GH release `v<version>` already exists
- `src/manifest.json` version unchanged vs last tag

### 2. Handle stale `demo-website/` version refs

If `stale_version_refs` is non-empty AND user did NOT pass `--ignore-stale-refs`:

1. **Warn** the user — list each `{path, line, content}` entry.
2. **Auto-bump** each file via `Edit` (replace old version with new).
3. **Commit** as a separate commit: `chore(site): bump version refs to v<version>`.
4. **Push** to origin.
5. Re-run pre-flight to refresh state.

Only auto-bump if the file path matches `demo-website/**`. Anything else (README, source code) — bail with a clearer message; manual decision needed.

### 3. Build + verify the zip

```pwsh
# Skip if zip already exists for this version
if (-not (Test-Path releases/ms-teams-downloader-v<version>.zip)) {
  pwsh scripts/package-extension.ps1
}
```

Verify contents with `unzip -l releases/ms-teams-downloader-v<version>.zip`:
- Exactly 6 entries.
- Files: `icons/icon128.png`, `content.js`, `intercept.js`, `manifest.json`, `modal.css`, `mux-worker.js`.
- NO `key.pem`, NO `.DS_Store`, NO `Thumbs.db`.

If any check fails, abort and tell the user.

### 4. Draft release notes

Run `scripts/generate-notes.ps1 -RangeStart <range_start> [-IncludeDocs] [-CreditAll] [-NoAttribution]`. It outputs markdown to stdout.

The script:
- Reads `git log <range_start>..HEAD --no-merges` with field separators.
- Buckets commits:
  - `demo-website/`-only commits → **Docs** bucket (skipped unless `-IncludeDocs`), regardless of conventional-commit prefix.
  - `feat` → **Features**
  - `fix` → **Bug fixes**
  - `perf` → **Performance**
  - `refactor` → **Refactors**
  - `docs`, `chore` → **Docs** (skipped unless `-IncludeDocs`)
  - Everything else → **Other**
- For each commit, resolves the GH author login via `gh api repos/{owner}/{repo}/commits/<sha> --jq .author.login` (cached per-SHA).
- Appends `by @login` for non-owner authors (use `-CreditAll` to credit owner too; `-NoAttribution` to disable entirely).
- Extracts trailing `(#N)` from subjects (squash-merge default) and re-renders as `in #N`.
- Skips known bots: `renovate[bot]`, `dependabot[bot]`, `github-actions[bot]`, `web-flow`.
- Renders each as `- <subject> (<short-sha>) [in #N] [by @login]`.

**After running the script:**
1. Show the rendered notes to the user.
2. Ask if they want to edit before publishing. If yes, open `RELEASE_NOTES.md` for them to edit; wait for confirmation it's saved.
3. If no edits, write the script output to `RELEASE_NOTES.md` (gitignored; see end of file).

Add a header above the bucketed sections:

```
## Highlights

<one-line user-facing summary of the release — ask the user for this>

## Changes
```

### 5. Tag and push

```pwsh
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

Annotated tag, not lightweight (`-a`, not just `git tag`). Push the tag separately from branch.

### 6. Create the GitHub release

Default = draft. Pass `--publish` to skip the draft step.

```pwsh
# Draft (default)
gh release create v<version> releases/ms-teams-downloader-v<version>.zip `
  --title "v<version>" `
  --notes-file RELEASE_NOTES.md `
  --draft

# Or publish immediately
gh release create v<version> releases/ms-teams-downloader-v<version>.zip `
  --title "v<version>" `
  --notes-file RELEASE_NOTES.md `
  --latest
```

If version contains `-` (pre-release semver like `1.5.0-beta.1`), add `--prerelease` and drop `--latest`.

GitHub auto-attaches source archives (`.tar.gz`, `.zip`) for the tag — don't try to add them yourself.

### 7. (Optional) CWS upload via `--cws-publish` / `--cws-submit`

Only if the user passed `--cws-publish` or `--cws-submit`. Otherwise skip this step entirely.

```pwsh
# Upload as draft (review in dashboard before submitting)
pwsh .claude/skills/gh-release/scripts/cws-publish.ps1 `
  -Zip releases/ms-teams-downloader-v<version>.zip

# Upload + submit for review (--cws-submit)
pwsh .claude/skills/gh-release/scripts/cws-publish.ps1 `
  -Zip releases/ms-teams-downloader-v<version>.zip `
  -Publish

# Submit to trusted testers track only (--cws-target trustedTesters)
pwsh .claude/skills/gh-release/scripts/cws-publish.ps1 `
  -Zip releases/ms-teams-downloader-v<version>.zip `
  -Publish -Target trustedTesters
```

**Exit codes:**
- `0` — uploaded (and submitted if `-Publish`) successfully.
- `1` — failure (script throws); report to user.
- `2` — credentials not configured in `releases/cws-publish.env`. Surface the script's output verbatim — it tells the user to run `cws-auth.ps1`. Do NOT treat as failure of the overall release; the GH release is already done.

### 7b. Publishing a draft after review (`publish-release.ps1`)

When the default workflow leaves a draft and the user later wants to ship it (typical: "publish v1.5.0 and push to CWS"), use the orchestrator instead of clicking the GitHub UI:

```pwsh
# GH only — flip the draft to published
pwsh .claude/skills/gh-release/scripts/publish-release.ps1 -Version <version>

# GH + CWS draft upload
pwsh .claude/skills/gh-release/scripts/publish-release.ps1 -Version <version> -CwsPublish

# GH + CWS upload + submit for review
pwsh .claude/skills/gh-release/scripts/publish-release.ps1 -Version <version> -CwsSubmit

# Submit to trusted testers track only
pwsh .claude/skills/gh-release/scripts/publish-release.ps1 -Version <version> -CwsSubmit -Target trustedTesters
```

The script: looks up the existing release via `gh release view`, runs `gh release edit --draft=false [--latest]` (drops `--latest` if the version contains `-`, e.g. pre-release), then optionally invokes `cws-publish.ps1` with the matching flags. Idempotent — re-running on an already-published release is a no-op for the GH side. Exit-code semantics match `cws-publish.ps1` (0 ok, 2 not-configured, otherwise failure).

### 8. Post-flight reminders

Print these to the user, verbatim. Adjust the CWS section based on what happened:

```
GH release: <url from gh output>
Zip: <abs-path-to-zip>

Next steps:
  1. Review the draft release notes at the URL above. When ready, either:
     - Click "Publish release" in the UI, or
     - Run pwsh .claude/skills/gh-release/scripts/publish-release.ps1 -Version <version>
       (add -CwsPublish or -CwsSubmit to push the zip to the Chrome Web Store
       in the same step).
  2. <Chrome Web Store status — see below>
  3. (Optional) If marketing screenshots need updating for this version,
     update chrome-store/screenshots/ and chrome-store/description.md.
```

CWS line variants based on what ran:
- No `--cws-publish`: `Upload to CWS manually: https://chrome.google.com/webstore/devconsole/`
- `--cws-publish` (draft): `CWS draft uploaded. Review at the dashboard and click "Submit for review" when ready.`
- `--cws-submit`: `CWS submission accepted. Track in the dashboard; review typically takes hours to days.`
- `--cws-publish` exited 2: `CWS not configured. Run pwsh .claude/skills/gh-release/scripts/cws-auth.ps1 to set up, then re-run with --cws-publish.`

Then delete `RELEASE_NOTES.md` (it's gitignored, but tidy up).

## CWS publish setup (one-time)

Required only if the user wants `--cws-publish` / `--cws-submit` to work.

### Prereqs

1. GCP project with the **Chrome Web Store API** enabled.
2. OAuth 2.0 Client ID of type **Desktop app** in that project (any GCP UI: APIs & Services → Credentials → Create credentials → OAuth client ID).
3. OAuth consent screen configured (External / Testing mode). The Google account that owns the extension must be added as a **Test user**.

### Populate `releases/cws-publish.env`

Lives in `releases/` which is gitignored. The file has four keys:

```
CWS_CLIENT_ID=...           # from the GCP OAuth client JSON
CWS_CLIENT_SECRET=...       # from the GCP OAuth client JSON
CWS_REFRESH_TOKEN=          # minted by cws-auth.ps1 (next step)
CWS_EXTENSION_ID=           # 32-char ID from CWS dashboard URL (or README badge URL)
```

If the user has the GCP-downloaded `client_secret_*.json`, extract `installed.client_id` and `installed.client_secret` into the env file, then delete the JSON. Never `git add -f` the env file — `releases/` is in `.gitignore` but the file contains live secrets, so be deliberate about not bypassing the ignore.

### Mint the refresh token

```pwsh
pwsh .claude/skills/gh-release/scripts/cws-auth.ps1
```

This spins up `http://localhost:8888`, opens a browser to Google's consent screen, captures the redirect, exchanges the code, and writes `CWS_REFRESH_TOKEN` back to the env file. Use `-Port <N>` if 8888 is taken.

Refresh tokens "don't expire" in the official docs but in practice do under: password change, 6+ months idle, security event, or revocation. If publish suddenly fails with a token-refresh error, re-run `cws-auth.ps1`.

### Add the extension ID

CWS Developer Dashboard → click the extension → URL contains `.../detail/<32-char-id>`. Paste into `CWS_EXTENSION_ID=`.

### What the API can NOT do

- Update screenshots, descriptions, support email, privacy policy, store listing — these stay manual via the dashboard.
- Set staged-rollout percentages.
- Approve faster than Google's normal review queue.

## Edge cases

- **Bootstrap (no prior tag)** — `last_tag` is null. `range_start` falls back to the commit immediately before the previous manifest version-bump commit (see `preflight.ps1`). On first run, show the user the resolved range and ask them to confirm before generating notes.
- **PR merge with squash vs no-squash** — both work; notes script reads subject lines either way.
- **User wants to amend notes post-publish** — `gh release edit v<version> --notes-file RELEASE_NOTES.md`. Don't re-tag.
- **User wants to delete a botched release** — `gh release delete v<version> --cleanup-tag`. Then re-run the skill from scratch.

## Don'ts

- Don't bump `src/manifest.json` yourself — that's the user's call (per CLAUDE.md "bump version first"). If pre-flight shows version unchanged, ask the user to bump and commit, then re-run.
- Don't sign tags / commits unless the user has set up GPG (no signing config in this repo).
- Don't include `src/key.pem` in any artifact — `package-extension.ps1` excludes it; verify after building.
- Don't auto-run `--cws-submit` without explicit user opt-in — it submits to Google's public review queue.
- Don't read or echo the contents of `releases/cws-publish.env` to the user (it has secrets). Reference the file by path only. If you must verify keys are populated, mask the values (e.g. `<set>`/`<empty>`).
- Don't create a CHANGELOG.md. GH release notes are the source of truth.

## .gitignore add

Make sure `RELEASE_NOTES.md` is in `.gitignore` (this skill writes it as scratch). If it's not, add it once and commit.
