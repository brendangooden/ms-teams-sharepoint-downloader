// This script runs in the page context to intercept fetch requests
(function() {
  const originalFetch = window.fetch;

  // Read a header (case-insensitive) from a fetch() call's arguments, regardless
  // of which call shape the caller used (Request object, init.headers as
  // Headers/array/plain-object).
  function extractHeader(args, headerName) {
    const key = headerName.toLowerCase();
    try {
      if (args[0] && typeof args[0] === 'object' && typeof args[0].headers !== 'undefined' && args[0].headers && typeof args[0].headers.get === 'function') {
        // Request object
        return args[0].headers.get(key);
      }
      const init = args[1];
      if (!init || !init.headers) return null;
      const h = init.headers;
      if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(key);
      if (Array.isArray(h)) {
        const e = h.find(p => Array.isArray(p) && p[0] && String(p[0]).toLowerCase() === key);
        return e ? e[1] : null;
      }
      if (typeof h === 'object') {
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === key) return h[k];
        }
      }
    } catch (_) { /* ignore — best-effort capture */ }
    return null;
  }
  function extractSpopActoken(args) { return extractHeader(args, 'x-spopactoken'); }
  function extractAuthorization(args) { return extractHeader(args, 'authorization'); }

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0];

    // Capture the SharePoint Stream API bearer token whenever the player hits a
    // `/_api/v2.x/...` endpoint on this host. The same token authenticates
    // transcript-metadata calls our extension makes proactively, and it works
    // for guest/anonymous viewers where cookie auth alone returns
    // "Anonymous or Email authenticated Guest User may not request tokens".
    if (url && typeof url === 'string' &&
        /\/_api\/v[0-9.]+\//.test(url) &&
        url.includes('sharepoint.com')) {
      const auth = extractAuthorization(args);
      if (auth && /^Bearer\s+/i.test(auth)) {
        window.postMessage({ type: 'SP_API_BEARER', authorization: auth }, '*');
      }
    }

    // Intercept transcript metadata responses; exclude the VTT content endpoint
    // and the /cdnmedia/ variant (binary protobuf, not JSON).
    if (url && typeof url === 'string' &&
        url.includes('transcripts') &&
        !url.includes('/content') &&
        !url.includes('/cdnmedia/')) {

      // Clone the response so we can read it
      const clone = response.clone();
      clone.json().then(data => {
        if (!data) return;

        // SharePoint Stream returns transcript metadata in several shapes:
        //  - { media: { transcripts: [ { temporaryDownloadUrl, ... } ] } }   (item w/ $expand=media/transcripts)
        //  - { value: [ { temporaryDownloadUrl, ... } ] }                    (direct /media/transcripts collection)
        //  - { temporaryDownloadUrl, ... }                                   (single transcript)
        let transcript = null;
        if (data.media && Array.isArray(data.media.transcripts) && data.media.transcripts.length > 0) {
          transcript = data.media.transcripts[0];
        } else if (Array.isArray(data.value) && data.value.length > 0 && data.value[0].temporaryDownloadUrl) {
          transcript = data.value.find(t => t.isDefault) || data.value[0];
        } else if (data.temporaryDownloadUrl) {
          transcript = data;
        }

        if (transcript && transcript.temporaryDownloadUrl) {
          window.postMessage({
            type: 'TRANSCRIPT_METADATA',
            temporaryDownloadUrl: transcript.temporaryDownloadUrl,
            displayName: transcript.displayName,
            languageTag: transcript.languageTag
          }, '*');
        }
      }).catch(err => console.error('[Transcript Downloader] Error parsing transcript metadata from', url, err));
    }

    // Detect videomanifest URLs for video download.
    // Microsoft has rolled out "TempAuthRemoval" on the .svc.ms media CDN. The
    // P1-P4 query-string signature alone isn't enough anymore; the CDN now
    // also requires an `x-spopactoken` bearer header (issued for the
    // "MediaTA" app). Without it we get HTTP 401 + x-errorcode: NoAccessToken.
    // Capture the player's token here so content.js can replay it on its own
    // fetches.
    if (url && typeof url === 'string' && url.includes('videomanifest') &&
        !/tempauth/i.test(url)) {
      let manifestUrl = url;
      // Trim URL at index&format=dash if present (keep up to and including that part)
      const dashIndex = manifestUrl.indexOf('index&format=dash');
      if (dashIndex !== -1) {
        manifestUrl = manifestUrl.substring(0, dashIndex + 'index&format=dash'.length);
      }
      const spopactoken = extractSpopActoken(args);
      console.log('[Transcript Downloader] Detected videomanifest URL:', manifestUrl,
        spopactoken ? '(with x-spopactoken)' : '(no token in request)');
      window.postMessage({
        type: 'VIDEO_MANIFEST_URL',
        manifestUrl: manifestUrl,
        spopactoken: spopactoken
      }, '*');
    }

    return response;
  };
})();

// Fallback: Try to extract videomanifest URL from g_fileInfo global
(function() {
  function extractManifestFromFileInfo() {
    if (typeof window.g_fileInfo === 'undefined') return null;

    const transformUrl = window.g_fileInfo['.transformUrl'] || window.g_fileInfo['.providerCdnTransformUrl'];
    if (!transformUrl) return null;

    try {
      const urlObj = new URL(transformUrl);
      urlObj.pathname = urlObj.pathname.replace(/\/transform\/.*$/, '/transform/videomanifest');
      // Ensure part=index&format=dash params are present
      urlObj.searchParams.set('part', 'index');
      urlObj.searchParams.set('format', 'dash');
      return urlObj.toString();
    } catch (e) {
      console.error('[Transcript Downloader] Error constructing manifest URL from g_fileInfo:', e);
      return null;
    }
  }

  function tryPostManifest() {
    const manifestUrl = extractManifestFromFileInfo();
    if (!manifestUrl) return false;
    // g_fileInfo carries the legacy tempauth-signed URL that the .svc.ms CDN
    // now rejects (see TempAuthRemoval rollout). Skip it — the fetch hook will
    // capture the fresh P1-P4 URL once the player loads.
    if (/tempauth/i.test(manifestUrl)) {
      console.debug('[Transcript Downloader] Skipping stale tempauth manifest from g_fileInfo; waiting for fresh URL');
      return false;
    }
    console.log('[Transcript Downloader] Extracted videomanifest from g_fileInfo:', manifestUrl);
    window.postMessage({
      type: 'VIDEO_MANIFEST_URL',
      manifestUrl: manifestUrl
    }, '*');
    return true;
  }

  // Relay the drive/item identity from g_fileInfo so the content script (which
  // runs in the isolated world and cannot read g_fileInfo) can proactively
  // fetch transcript metadata. Unlike the videomanifest — which is only
  // requested once playback starts — g_fileInfo['.spItemUrl'] is present on
  // page load. This is what fixes the Teams meeting-recap embed, where the user
  // opens the Transcript panel without ever starting the video, so no manifest
  // request fires for the content script to derive driveId/itemId from.
  let transcriptContextPosted = false;
  function tryPostTranscriptContext() {
    if (transcriptContextPosted) return true;
    const g = window.g_fileInfo;
    const spItemUrl = g && g['.spItemUrl'];
    if (!spItemUrl) return false;
    try {
      const u = new URL(spItemUrl);
      const m = u.pathname.match(/^(\/(?:personal|sites)\/[^/]+)\/_api\/v[0-9.]+\/drives\/([^/]+)\/items\/([^/?]+)/);
      if (!m) return false;
      // Best human name for the file, extension stripped. document.title is
      // unreliable in the Teams recap embed (it's the Teams shell title, not
      // the video name), so relay the real name for the download dialogs.
      const fileName = g.displayName ||
        (g.name ? g.name.replace(/\.[^.]+$/, '') : null) ||
        g.title || null;
      console.log('[Transcript Downloader] Relaying transcript context from g_fileInfo (hasTranscripts=' + g.hasTranscripts + ')');
      window.postMessage({
        type: 'TRANSCRIPT_CONTEXT',
        sitePath: m[1],
        driveId: m[2],
        itemId: m[3],
        hasTranscripts: g.hasTranscripts,
        fileName: fileName
      }, '*');
      transcriptContextPosted = true;
      return true;
    } catch (e) {
      console.error('[Transcript Downloader] Error parsing g_fileInfo .spItemUrl:', e);
      return false;
    }
  }

  // Relay the AES-128-CBC decryption key + IV for the oneDrive.transcode
  // format (issue #22). Microsoft encrypts the whole segment (init +
  // media) and puts the key/IV in `g_streamBootstrapContent.dashConfig
  // .cdnDecryptionKey` on the main thread. The content script (isolated world)
  // can't read that global, so relay it here. keyBuffer/iv are Uint8Arrays;
  // send plain arrays so the message survives structured cloning cleanly.
  let decryptionKeyPosted = false;
  function tryPostDecryptionKey() {
    if (decryptionKeyPosted) return true;
    try {
      const dc = window.g_streamBootstrapContent && window.g_streamBootstrapContent.dashConfig;
      const ck = dc && dc.cdnDecryptionKey;
      if (!ck || ck.valid === false) return false;
      const kb = ck.keyBuffer, iv = ck.iv;
      if (!(kb && kb.length === 16 && iv && iv.length === 16)) return false;
      window.postMessage({
        type: 'TRANSCODE_DECRYPTION_KEY',
        keyBytes: Array.from(kb),
        iv: Array.from(iv),
        keyId: ck.keyId || null
      }, '*');
      decryptionKeyPosted = true;
      console.log('[Transcript Downloader] Relayed transcode decryption key from g_streamBootstrapContent');
      return true;
    } catch (e) {
      console.debug('[Transcript Downloader] Error reading cdnDecryptionKey:', e);
      return false;
    }
  }

  function tryPostAll() {
    // `&` not `&&` — always attempt all; only report done when the two
    // load-time posts succeed. The decryption key populates only once playback
    // bootstraps, so it has its own poll below and doesn't gate "done" here.
    tryPostDecryptionKey();
    return tryPostManifest() & tryPostTranscriptContext() ? true : false;
  }

  // The decryption key isn't present at page load — it appears once the player
  // bootstraps playback. Poll for it independently of the manifest/context
  // race, then stop once relayed (or after ~60s).
  (function pollDecryptionKey() {
    if (tryPostDecryptionKey()) return;
    let tries = 0;
    const iv = setInterval(() => {
      if (tryPostDecryptionKey() || ++tries >= 60) clearInterval(iv);
    }, 1000);
  })();

  // Try immediately
  if (!tryPostAll()) {
    // Hook into OnLoadVideoFileInfo if available
    const originalOnLoad = window.OnLoadVideoFileInfo;
    window.OnLoadVideoFileInfo = function() {
      if (originalOnLoad) originalOnLoad.apply(this, arguments);
      tryPostAll();
    };

    // Also try on window load
    window.addEventListener('load', function() {
      setTimeout(tryPostAll, 1000);
    });
  }

  // The content script (isolated world) may attach its message listener AFTER
  // our initial one-shot post, so it asks us to re-send on demand. Reset the
  // guard and re-post whatever we have. This is the fix for intermittent
  // transcript-context capture caused by the intercept/content load-order race.
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'TTD_REQUEST_CONTEXT') {
      transcriptContextPosted = false;
      // Reset the guard so we re-post the key: intercept.js (MAIN, document_start)
      // relays it once before content.js (document_idle) has attached its
      // listener, so the first post is missed. content.js asks again via this
      // message once it's ready. Without the reset, tryPostDecryptionKey()
      // short-circuits on decryptionKeyPosted and the key never arrives.
      decryptionKeyPosted = false;
      tryPostTranscriptContext();
      tryPostManifest();
      tryPostDecryptionKey();
    }
  });
})();
