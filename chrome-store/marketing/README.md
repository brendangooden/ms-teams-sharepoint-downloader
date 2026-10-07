# Store marketing images

An alternative to the plain UI captures in `../screenshots/`: the same UI, framed with a headline, in the demo site's look (Instrument Serif, JetBrains Mono, cream `#f5f1e6`, red and purple accents).

| File | Size | Use |
|---|---|---|
| `screenshot-1-download-menu.png` | 1280×800 | Screenshot 1: the Download menu in the command bar |
| `screenshot-2-video-formats.png` | 1280×800 | Screenshot 2: formats and the subtitles switch |
| `screenshot-3-transcripts.png` | 1280×800 | Screenshot 3: transcript formats and options (dark UI) |
| `screenshot-4-subtitles.png` | 1280×800 | Screenshot 4: subtitles with speaker names in a player |
| `screenshot-5-private.png` | 1280×800 | Screenshot 5: the toolbar popup, privacy |
| `promo-small-440x280.png` | 440×280 | Small promo tile (no text, per the store's guidance) |
| `promo-marquee-1400x560.png` | 1400×560 | Marquee promo tile (optional) |

All are 24-bit RGB PNGs with no alpha, at the exact sizes the dashboard asks for.

The listing shows screenshots at about 593×371 (measured on the live page at 1280, 1440 and 1920 px wide windows), so the UI in them is enlarged, focused crops rather than whole dialogs. Check new versions at that size, not just at 1280×800.

## How they're made

- The UI is the extension's own rendering, captured at 2x on a test page with made-up meeting data (Priya Shah, Tom Becker, Lena Novak). No real recordings or tenants.
- Each image is an HTML/CSS page using the demo site's fonts and colours, rendered with Playwright at the exact size and compressed with `oxipng`.
- No Microsoft or Teams logos.

They show the UI from the Download menu, the footer buttons in the download modals, and the toolbar popup, so they match the listing once those are released.
