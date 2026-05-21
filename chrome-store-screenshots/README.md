# Chrome Web Store screenshots

Dark-theme screenshots resized to the **exact** Chrome Web Store spec for upload to the [listing](../chrome-web-store-description.md):

- 1280 × 800 px
- 24-bit PNG (no alpha)
- Up to 5 allowed; we use 3

Sourced from `demo-website/src/assets/screenshots/dark/*.png` (the full-resolution marketing PNGs). Each source is fit-inside 1280×800 preserving aspect ratio, with letterbox/pillarbox bars in the SharePoint dark fluent BG (`rgb(19,19,27)`) so the bars blend with the recording shot.

| File | Source aspect | Bars |
|---|---|---|
| `recording.png` | 1905×791 (2.41:1) | top/bottom letterbox |
| `video-modal.png` | 1080×680 (1.59:1) | small left/right pillarbox |
| `transcript-modal.png` | 1580×798 (1.98:1) | top/bottom letterbox |

## Regenerating

After updating any of the dark screenshots in `demo-website/src/assets/screenshots/dark/`, re-derive these via the section in `scripts/regen-screenshots.md` titled "Chrome Web Store variants" (the playbook is gitignored). The script is a self-contained `Format24bppRgb` resize — no DPI awareness, no MCP, no live page state needed.
