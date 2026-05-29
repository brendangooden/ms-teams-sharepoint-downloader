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
        /sharepoint(?:-mil)?\.(?:com|us)/.test(url)) {
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

  // Try immediately
  if (!tryPostManifest()) {
    // Hook into OnLoadVideoFileInfo if available
    const originalOnLoad = window.OnLoadVideoFileInfo;
    window.OnLoadVideoFileInfo = function() {
      if (originalOnLoad) originalOnLoad.apply(this, arguments);
      tryPostManifest();
    };

    // Also try on window load
    window.addEventListener('load', function() {
      setTimeout(tryPostManifest, 1000);
    });
  }
})();
