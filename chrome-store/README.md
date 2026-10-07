# Chrome Web Store assets

Listing copy and screenshot uploads for the [Chrome Web Store](https://chromewebstore.google.com/) page.

- `description.md` — long-form listing copy (paste into the Web Store "Description" field).
- `screenshots/` — the dark-theme screenshots at the **exact** Web Store screenshot spec:
  - 1280 × 800 px
  - 24-bit PNG (no alpha)
  - Up to 5 allowed; we use 4

## Screenshots

Sourced from `demo-website/src/assets/screenshots/dark/*.png` (the full-resolution marketing PNGs). Each source is fit-inside 1280×800 preserving aspect ratio, with letterbox/pillarbox bars in the SharePoint dark fluent BG (`rgb(19,19,27)`) so the bars blend with the recording shot.

| File | Source aspect | Bars |
|---|---|---|
| `screenshots/recording.png` | 1905×791 (2.41:1) | top/bottom letterbox |
| `screenshots/video-modal.png` | 1170×689 (1.70:1) | small top/bottom letterbox |
| `screenshots/transcript-modal.png` | 1685×895 (1.88:1) | top/bottom letterbox |

`screenshots/popup.png` isn't derived from a demo-site image. It's the real toolbar popup (`chrome-extension://<id>/popup.html`, dark theme, rendered at 2x) placed under a mock Chrome toolbar, over a blurred copy of the dark `recording.png`, composed directly at 1280×800.

### Regenerating

After updating any of the dark screenshots in `demo-website/src/assets/screenshots/dark/`, re-derive these via the section in `scripts/regen-screenshots.md` titled "Chrome Web Store variants" (the playbook is gitignored). The script is a self-contained `Format24bppRgb` resize — no DPI awareness, no MCP, no live page state needed.

## Marketing images

`marketing/` has an alternative set: the same UI framed with a headline in the demo site's look, plus the small and marquee promo tiles. See `marketing/README.md`.
