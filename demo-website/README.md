# teamsvideotranscriptexporter.com

Marketing site for the **MS Teams Video & Transcript Downloader** Chrome extension. Built with Astro + Tailwind v4. Zero framework JS shipped.

> The site is branded "Teams Video & Transcript Exporter" (matching the domain), but the underlying extension keeps its existing name on the Chrome Web Store and in the repo. Same product, two surface labels.

## Local

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # outputs to dist/
npm run preview   # serve the built dist/
```

## Deploy — Cloudflare Pages (Git integration)

Cloudflare auto-builds and deploys on push. One-time setup:

1. **Cloudflare Dashboard** → Workers & Pages → **Create application** → Pages → **Connect to Git**
2. Pick this repository
3. Build configuration:
   - Production branch: `main`
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: `demo-website`
   - Env var: `NODE_VERSION = 22`
4. **Save and Deploy** — the first build runs immediately
5. After deploy succeeds, go to **Settings → Builds & deployments → Build watch paths** and add:
   ```
   demo-website/**
   ```
   This makes CF skip builds for commits that don't touch the site directory.
6. **Custom domains** → add both:
   - `teamsvideotranscriptexporter.com`
   - `www.teamsvideotranscriptexporter.com`

   If the domain is registered with Cloudflare Registrar, this is one click. Otherwise, point the nameservers to Cloudflare (free) so apex CNAME flattening works.

## Updating content

- Product copy source of truth: `../chrome-store/description.md` and `../README.md`
- Screenshots: `src/assets/screenshots/{dark,light}/{recording,video-modal,transcript-modal}.png`
- Brand colour tokens: `src/styles/global.css` (`--red`, `--purple`, `--green`, etc.)

## License

MIT.
