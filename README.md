# MS Teams / SharePoint / Stream — Video & Transcript Downloader (Chrome Extension)

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hmljlkhcebhkkhbbafiheolbneecoinp?label=chrome%20web%20store&logo=googlechrome&logoColor=white&color=4285F4)](https://chromewebstore.google.com/detail/ms-teams-transcript-downl/hmljlkhcebhkkhbbafiheolbneecoinp)
[![Users](https://img.shields.io/chrome-web-store/users/hmljlkhcebhkkhbbafiheolbneecoinp?label=users&color=34A853)](https://chromewebstore.google.com/detail/ms-teams-transcript-downl/hmljlkhcebhkkhbbafiheolbneecoinp)
[![Rating](https://img.shields.io/chrome-web-store/rating/hmljlkhcebhkkhbbafiheolbneecoinp?label=rating&color=FBBC04)](https://chromewebstore.google.com/detail/ms-teams-transcript-downl/hmljlkhcebhkkhbbafiheolbneecoinp/reviews)
[![GitHub stars](https://img.shields.io/github/stars/brendangooden/ms-teams-sharepoint-downloader?style=flat&logo=github&label=stars&color=EA4335)](https://github.com/brendangooden/ms-teams-sharepoint-downloader/stargazers)
[![License](https://img.shields.io/github/license/brendangooden/ms-teams-sharepoint-downloader?color=blue)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-9333ea)](src/manifest.json)

🌐 **Website:** [teamsvideotranscriptexporter.com](https://teamsvideotranscriptexporter.com) — features, screenshots, FAQ, install link

Download videos and transcripts from MS Teams meeting recordings, SharePoint, and **Microsoft Stream** (videos uploaded to SharePoint/OneDrive and played through the Stream player) — even when the built-in download button is disabled.

![Red Download Video and purple Download Transcript buttons added to the SharePoint command bar](demo-website/src/assets/screenshots/dark/recording.png)

Works on:

- `teams.microsoft.com` and `teams.cloud.microsoft` (Teams web client)
- `*.sharepoint.com` meeting-recording links
- `*.sharepoint.com/.../_layouts/15/stream.aspx` — the Stream-on-SharePoint player (any MP4 someone uploaded to SharePoint or OneDrive and shared)

> **About Microsoft Stream:** Microsoft retired the standalone *Stream (Classic)* product at `web.microsoftstream.com` in early 2024. The current *Stream (on SharePoint)* product reuses the same player whenever an MP4 lives on SharePoint or OneDrive, so this extension covers it automatically.

## Features

### Video / Audio download
- **In-browser download** — Video+Audio (MP4), Audio Only (M4A), or Video Only. No extra tools needed.
- **Parallel segment fetching** — tunable concurrency (1–16 segments at once) with automatic backoff if SharePoint throttles. Multi-threaded mux off the UI thread.
- **Editable filename** — auto-derived from the page title.
- **Floating banner widget** as a fallback for when the SharePoint command bar re-renders or hides the button.

### Transcript download
- **Automatic detection** — the extension watches for the transcript metadata call and adds a Download Transcript button.
- **Three formats** — RAW JSON, standard WebVTT, or Grouped VTT (consecutive lines from the same speaker collapsed into a block).
- **Live preview** of each format in the modal.
- **Last-used format remembered** across sessions.
- Clear dialog if the meeting was never transcribed, instead of a silent failure.

## Screenshots

> Light-mode versions live next to these in `demo-website/src/assets/screenshots/light/`.

### Video download modal

![Video Download Modal](demo-website/src/assets/screenshots/dark/video-modal.png)

### Transcript format modal

![Transcript Format Modal](demo-website/src/assets/screenshots/dark/transcript-modal.png)

## Installation

### Method 1 — Chrome Web Store

Open <https://chromewebstore.google.com/detail/ms-teams-transcript-downl/hmljlkhcebhkkhbbafiheolbneecoinp> and click **Add to Chrome**.

### Method 2 — Load unpacked (development)

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the `src/` folder.
5. You should see **MS Teams Video & Transcript Downloader** in the list.

## Usage

### Downloading video / audio

1. Open any meeting recording or shared MP4 in Teams, SharePoint, or the Stream-on-SharePoint player.
2. Click the red **Download Video** button in the command bar (or in the floating banner at the top of the page).
3. Pick a format and click **Download**. The file lands in your Downloads folder.
4. *Optional:* tune the **Parallel segment downloads** selector (default 4) — higher = faster, but increases the chance of SharePoint throttling. 429s are auto-retried.

### Downloading the transcript

1. Open the **Transcript** tab on a recording.
2. Click **Download Transcript** in the transcript panel (or in the floating banner).
3. Pick a format in the modal and click **Download**.

Your last-used format is remembered as the default.

## File structure

```
src/
├── manifest.json   # MV3 — intercept.js runs MAIN/document_start, content.js runs ISOLATED/document_idle
├── intercept.js    # fetch() interceptor — captures transcript + video manifest URLs and auth tokens
├── content.js      # UI, transcript flow, video download, modals, floating widget
├── modal.css       # Styles
└── icons/
```

## Permissions

- `storage` — remember the user's last-used transcript format.
- Host permissions on `teams.microsoft.com`, `teams.cloud.microsoft`, and `*.sharepoint.com`.

## Troubleshooting

### Buttons don't appear
1. Refresh the page after installing.
2. Open DevTools (F12) → Console and look for `[Transcript Downloader]` messages.
3. Verify the URL is on `teams.microsoft.com`, `teams.cloud.microsoft`, or `*.sharepoint.com`.
4. Wait a few seconds — the transcript metadata call may not have fired yet.

### Download fails
1. Check the console for errors.
2. Verify the video / transcript actually plays in the native UI.
3. Refresh the page (auth tokens are short-lived) and try again.
4. Confirm you have permission to view the content.

### Extension not working
1. Reload it from `chrome://extensions/`.
2. Clear cache and reload the SharePoint/Teams page.

## Privacy & security

- All processing happens locally in the browser — no data is sent to any external server.
- No tracking, no analytics.
- Open source.
- The extension only uses the same Microsoft URLs the native player already calls.

## Known limitations

- Chrome / Edge only (Manifest V3).
- Only works when you can actually view the content in the native UI — it cannot bypass access restrictions.
- Output formats are MP4 (video, video+audio) and M4A (audio only). MP3 / WAV are no longer supported — Microsoft now AES-128-CBC encrypts SharePoint Stream segments, and no external CLI tool (ffmpeg, yt-dlp, etc.) can handle the resulting fragments. Transcode in-browser-downloaded files locally if you need a different format.

### Will NOT work in these scenarios

- **DRM-protected videos.** Microsoft hard-DRM-protects some recordings; the bytes can only be decrypted by the browser's built-in DRM module during playback. No client-side tool can produce a playable file. The extension detects this and shows a clear dialog rather than producing a broken download.
- **Guest / unauthenticated viewers.** When SharePoint refuses to mint tokens for guests, the segment downloads fail even though the native player still plays the video. Sign in as a tenant member, or ask the owner to share the file directly via OneDrive.

## License

MIT — see `LICENSE`.

## Reporting bugs

Open an issue on GitHub and pick the **Bug report** template. It asks for the things that actually help diagnose problems:

- Page URL **pattern** (redact tenant/file IDs — only the shape is needed)
- Chrome DevTools console output (F12 → Console → filter by `Transcript Downloader`)
- Screenshots of the page, the modal, or the console
- Extension version and browser/OS

Please redact tenant names, file titles, attendee names, etc. before posting.

## Contributing

Pull requests welcome.

## Credits

Built to help people access their own Teams / SharePoint / Stream recordings and transcripts when the built-in download button is disabled by org policy.

---

**Note:** Intended for accessing your own meeting recordings and transcripts. Respect copyright and privacy policies.

## Star History

<a href="https://www.star-history.com/?repos=brendangooden%2Fms-teams-sharepoint-downloader">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=brendangooden/ms-teams-sharepoint-downloader&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=brendangooden/ms-teams-sharepoint-downloader&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=brendangooden/ms-teams-sharepoint-downloader&type=date&legend=top-left" />
 </picture>
</a>