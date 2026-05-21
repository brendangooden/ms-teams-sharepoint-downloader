# CLAUDE.md

Guidance for Claude when working in this repo.

## Project layout

- `src/` — extension source. `content.js`, `intercept.js`, `mux-worker.js`, `modal.css`, `manifest.json`, `icons/`.
- `src/key.pem` — local signing key. **Must not** ship in any release zip.
- `scripts/` — repo utilities.
- `demo-website/` — separate marketing site (Cloudflare Workers). Unrelated to the extension build.
- `ms-teams-downloader-v<version>.zip` at repo root — Chrome Web Store upload artifact, one per release.

## Building a release zip

Always use `scripts/package-extension.ps1` — do not zip `src/` manually. The script reads `version` from `src/manifest.json`, refuses to overwrite an existing zip (bump the version first), excludes `key.pem` + `.DS_Store` + `Thumbs.db`, and writes `ms-teams-downloader-v<version>.zip` to the repo root.

```pwsh
# 1. Bump src/manifest.json "version"
# 2. Run:
pwsh scripts/package-extension.ps1
# Use -Force only if you intentionally want to overwrite an existing zip.
```

Verify the result with `unzip -l ms-teams-downloader-v<version>.zip` — expect 6 entries (`icons/icon128.png`, `content.js`, `intercept.js`, `manifest.json`, `modal.css`, `mux-worker.js`) and no `key.pem`.

## Don'ts

- Never add `chrome.cookies` permission or a background service worker to extract SharePoint session cookies, even to "improve" CLI tool support. Tested: segment URLs require `FedAuth` + `rtFa` (HttpOnly) and baking those into a copy-paste script exposes the user's full session. The in-browser path is the only one we support.
- Don't bring back the ffmpeg / yt-dlp tabs in the video modal. Microsoft now DASH-SEA AES-128-CBC encrypts Stream segments; yt-dlp refuses all `<ContentProtection>` streams as DRM, and ffmpeg's DASH demuxer doesn't implement DASH-SEA. The modal note states this — don't soften it.
