// This script runs in the page context to intercept media requests.
// OnePlayer now fetches DASH/transcode URLs from a dedicated Web Worker, so
// hooking window.fetch alone never sees them. We wrap Worker construction,
// listen on a BroadcastChannel from the worker hook, and still watch page
// fetch/XHR + resource timing as fallbacks.
(function() {
  const originalFetch = window.fetch;
  const TTD_CHANNEL = 'ttd-media-urls';

  function extractHeader(args, headerName) {
    const key = headerName.toLowerCase();
    try {
      if (args[0] && typeof args[0] === 'object' && typeof args[0].headers !== 'undefined' && args[0].headers && typeof args[0].headers.get === 'function') {
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

  function urlFromFetchArgs(args) {
    const a = args && args[0];
    if (!a) return '';
    if (typeof a === 'string') return a;
    if (typeof a === 'object' && a.url) return String(a.url);
    try { return String(a); } catch (_) { return ''; }
  }

  let lastPostedManifest = null;
  let lastPostedTranscode = null;

  function stripTempauth(rawUrl) {
    if (!rawUrl || !/tempauth/i.test(rawUrl)) return rawUrl;
    try {
      const urlObj = new URL(rawUrl);
      urlObj.searchParams.delete('tempauth');
      const docid = urlObj.searchParams.get('docid');
      if (docid) {
        try {
          const docUrl = new URL(decodeURIComponent(docid));
          docUrl.searchParams.delete('tempauth');
          urlObj.searchParams.set('docid', docUrl.href);
        } catch (_) { /* ignore malformed docid */ }
      }
      return urlObj.toString();
    } catch (_) {
      return rawUrl;
    }
  }

  function normalizeManifestUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    let u = stripTempauth(rawUrl);
    const altIdx = u.indexOf('&altManifestMetadata');
    if (altIdx !== -1) u = u.substring(0, altIdx);
    if (!/[?&]p[1-4]=/i.test(u)) {
      const dashIndex = u.indexOf('index&format=dash');
      if (dashIndex !== -1) {
        u = u.substring(0, dashIndex + 'index&format=dash'.length);
      }
    }
    return u;
  }

  function classifyMediaUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (!/^https?:/i.test(rawUrl)) return null;
    const u = rawUrl;
    if (u.includes('videomanifest')) return 'manifest';
    if (/oneDrive\.transcode|videotranscode/i.test(u)) {
      try {
        const parsed = new URL(u);
        const part = (parsed.searchParams.get('part') || '').toLowerCase();
        if (part === 'index') return 'manifest';
        if (part === 'mediasegment' || part === 'fragment' || parsed.searchParams.has('segmentTime')) {
          return 'transcode';
        }
        const fmt = (parsed.searchParams.get('format') || '').toLowerCase();
        if (fmt === 'dash') return 'manifest';
      } catch (_) { /* fall through */ }
      return 'transcode';
    }
    return null;
  }

  function relayToContent(payload) {
    window.postMessage(payload, '*');
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch (_) { /* cross-origin iframe */ }
    try {
      const root = document.documentElement;
      if (payload.type === 'VIDEO_MANIFEST_URL' && payload.manifestUrl) {
        root.setAttribute('data-ttd-video-manifest', payload.manifestUrl);
      }
      if (payload.type === 'VIDEO_TRANSCODE_URL' && payload.transcodeUrl) {
        root.setAttribute('data-ttd-video-transcode', payload.transcodeUrl);
      }
      if (payload.spopactoken) root.setAttribute('data-ttd-spop-token', payload.spopactoken);
    } catch (_) { /* ignore */ }
  }

  function postManifest(rawUrl, spopactoken, source, forceRelay) {
    const kind = classifyMediaUrl(rawUrl);
    if (kind === 'transcode') return postTranscode(rawUrl, spopactoken, source, forceRelay);
    if (kind !== 'manifest' && !(rawUrl && rawUrl.includes('videomanifest'))) return false;

    const manifestUrl = normalizeManifestUrl(rawUrl);
    if (!manifestUrl) return false;
    if (manifestUrl === lastPostedManifest && !spopactoken && !forceRelay) return true;
    lastPostedManifest = manifestUrl;

    console.log('[Transcript Downloader] Detected DASH index URL' +
      (source ? ' (' + source + ')' : '') + ':', manifestUrl,
      spopactoken ? '(with x-spopactoken)' : '(no token in request)');
    relayToContent({
      type: 'VIDEO_MANIFEST_URL',
      manifestUrl: manifestUrl,
      spopactoken: spopactoken || null
    });
    return true;
  }

  function postTranscode(rawUrl, spopactoken, source, forceRelay) {
    if (!rawUrl) return false;
    const transcodeUrl = stripTempauth(rawUrl);
    if (transcodeUrl === lastPostedTranscode && !spopactoken && !forceRelay) return true;
    lastPostedTranscode = transcodeUrl;

    console.log('[Transcript Downloader] Detected oneDrive.transcode URL' +
      (source ? ' (' + source + ')' : '') + ':', transcodeUrl);
    relayToContent({
      type: 'VIDEO_TRANSCODE_URL',
      transcodeUrl: transcodeUrl,
      spopactoken: spopactoken || null
    });
    return true;
  }

  function postSpopActoken(token, source) {
    if (!token) return;
    const cleaned = String(token).replace(/^Bearer\s+/i, '').trim();
    if (!cleaned) return;
    window.postMessage({ type: 'SPOP_ACTOKEN', spopactoken: cleaned, source: source || null }, '*');
  }

  function handleMediaRequest(url, token, source) {
    if (!url) return;
    const kind = classifyMediaUrl(url);
    if (kind === 'manifest') postManifest(url, token, source);
    else if (kind === 'transcode') postTranscode(url, token, source);
    if (token) postSpopActoken(token, source);
  }

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = urlFromFetchArgs(args);

    if (url && /\/_api\/v[0-9.]+\//.test(url) && url.includes('sharepoint.com')) {
      const auth = extractAuthorization(args);
      if (auth && /^Bearer\s+/i.test(auth)) {
        window.postMessage({ type: 'SP_API_BEARER', authorization: auth }, '*');
      }
    }

    if (url && url.includes('transcripts') &&
        !url.includes('/content') &&
        !url.includes('/cdnmedia/')) {
      const clone = response.clone();
      clone.json().then(data => {
        if (!data) return;
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

    handleMediaRequest(url, extractSpopActoken(args), 'fetch');
    return response;
  };

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__ttdUrl = url;
      this.__ttdHeaders = {};
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      try {
        if (name) this.__ttdHeaders[String(name).toLowerCase()] = value;
      } catch (_) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      const url = this.__ttdUrl;
      const token = this.__ttdHeaders && this.__ttdHeaders['x-spopactoken'];
      if (url) handleMediaRequest(String(url), token, 'xhr');
      return origSend.apply(this, arguments);
    };
  } catch (_) { /* ignore */ }

  // BroadcastChannel is visible across dedicated workers and this page world
  // without colliding with OnePlayer's own worker.postMessage protocol.
  try {
    const bc = new BroadcastChannel(TTD_CHANNEL);
    bc.onmessage = function(ev) {
      const d = ev.data;
      if (!d || !d.url) return;
      handleMediaRequest(d.url, d.spopactoken || null, d.source || 'worker');
    };
  } catch (_) { /* BroadcastChannel unsupported */ }

  const WORKER_HOOK = [
    '(function(){',
    'try{',
    'var ch=new BroadcastChannel("' + TTD_CHANNEL + '");',
    'function report(u,tok){try{if(!u)return;ch.postMessage({url:String(u),spopactoken:tok||null,source:"worker"});}catch(e){}}',
    'function fromArgs(a){if(!a||!a.length)return"";var x=a[0];if(typeof x==="string")return x;if(x&&x.url)return String(x.url);return String(x);}',
    'function tokFromArgs(a){try{var h=a[1]&&a[1].headers;if(!h){if(a[0]&&a[0].headers&&a[0].headers.get)return a[0].headers.get("x-spopactoken");return null;}if(typeof Headers!=="undefined"&&h instanceof Headers)return h.get("x-spopactoken");if(typeof h==="object"){for(var k in h){if(k.toLowerCase()==="x-spopactoken")return h[k];}}}catch(e){}return null;}',
    'var of=self.fetch;self.fetch=function(){report(fromArgs(arguments),tokFromArgs(arguments));return of.apply(this,arguments);};',
    'if(self.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send,xh=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.open=function(m,u){this.__ttdU=u;this.__ttdH={};return xo.apply(this,arguments);};XMLHttpRequest.prototype.setRequestHeader=function(n,v){try{this.__ttdH[String(n).toLowerCase()]=v;}catch(e){}return xh.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){report(this.__ttdU,this.__ttdH&&this.__ttdH["x-spopactoken"]);return xs.apply(this,arguments);};}',
    '}catch(e){}',
    '})();'
  ].join('');

  function wrapWorkerScript(scriptURL, options) {
    const abs = new URL(scriptURL, location.href).href;
    const isModule = options && options.type === 'module';
    const code = isModule
      ? WORKER_HOOK + '\nimport ' + JSON.stringify(abs) + ';\n'
      : WORKER_HOOK + '\nimportScripts(' + JSON.stringify(abs) + ');\n';
    return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }

  function patchWorkerCtor(Native) {
    if (!Native) return Native;
    function PatchedWorker(scriptURL, options) {
      try {
        return new Native(wrapWorkerScript(scriptURL, options), options);
      } catch (_) {
        return new Native(scriptURL, options);
      }
    }
    PatchedWorker.prototype = Native.prototype;
    try { Object.setPrototypeOf(PatchedWorker, Native); } catch (_) { /* ignore */ }
    return PatchedWorker;
  }

  try {
    if (window.Worker) window.Worker = patchWorkerCtor(window.Worker);
  } catch (_) { /* ignore */ }
  try {
    if (window.SharedWorker) window.SharedWorker = patchWorkerCtor(window.SharedWorker);
  } catch (_) { /* ignore */ }

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const po = new PerformanceObserver(function(list) {
        for (const entry of list.getEntries()) {
          handleMediaRequest(entry.name, null, 'performance');
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (_) { /* ignore */ }
  }

  window.__ttdPostVideoManifest = postManifest;
  window.__ttdLastPostedManifest = function() { return lastPostedManifest; };
  window.__ttdLastPostedTranscode = function() { return lastPostedTranscode; };
})();

// Fallback: extract media URLs from g_fileInfo (present on stream.aspx load).
(function() {
  function stripTempauthFromUrl(urlObj) {
    urlObj.searchParams.delete('tempauth');
    const docid = urlObj.searchParams.get('docid');
    if (!docid) return;
    try {
      const docUrl = new URL(decodeURIComponent(docid));
      docUrl.searchParams.delete('tempauth');
      urlObj.searchParams.set('docid', docUrl.href);
    } catch (_) { /* ignore malformed docid */ }
  }

  function extractManifestFromFileInfo() {
    if (typeof window.g_fileInfo === 'undefined') return null;
    const transformUrl = window.g_fileInfo['.transformUrl'] || window.g_fileInfo['.providerCdnTransformUrl'];
    if (!transformUrl) return null;
    try {
      const urlObj = new URL(transformUrl);
      urlObj.pathname = urlObj.pathname.replace(/\/transform\/.*$/, '/transform/videomanifest');
      urlObj.searchParams.set('part', 'index');
      urlObj.searchParams.set('format', 'dash');
      stripTempauthFromUrl(urlObj);
      return urlObj.toString();
    } catch (e) {
      console.error('[Transcript Downloader] Error constructing manifest URL from g_fileInfo:', e);
      return null;
    }
  }

  function extractTranscodeIndexFromFileInfo() {
    if (typeof window.g_fileInfo === 'undefined') return null;
    const spItemUrl = window.g_fileInfo['.spItemUrl'];
    if (!spItemUrl) return null;
    try {
      const u = new URL(spItemUrl);
      const m = u.pathname.match(/\/_api\/v[0-9.]+\/drives\/([^/]+)\/items\/([^/?]+)/);
      if (!m) return null;
      const index = new URL(u.origin + '/_api_cached/v2.1/drives/' + m[1] + '/items/' + m[2] + '/oneDrive.transcode');
      index.searchParams.set('version', 'Published');
      index.searchParams.set('part', 'index');
      index.searchParams.set('format', 'dash');
      return index.toString();
    } catch (_) {
      return null;
    }
  }

  function scanGFileInfoForToken(g) {
    if (!g) return;
    try {
      const json = JSON.stringify(g);
      const m = json.match(/"(?:x-)?spopactoken"\s*:\s*"([^"]+)"/i) ||
        json.match(/"mediaAccessToken"\s*:\s*"([^"]+)"/i);
      if (m && m[1]) {
        window.postMessage({ type: 'SPOP_ACTOKEN', spopactoken: m[1], source: 'g_fileInfo' }, '*');
      }
    } catch (_) { /* ignore */ }
  }

  function tryPostManifest(forceRelay) {
    scanGFileInfoForToken(window.g_fileInfo);
    let posted = false;
    const manifestUrl = extractManifestFromFileInfo();
    if (manifestUrl && typeof window.__ttdPostVideoManifest === 'function') {
      console.log('[Transcript Downloader] Extracted videomanifest from g_fileInfo (tempauth stripped):', manifestUrl);
      window.__ttdPostVideoManifest(manifestUrl, null, 'g_fileInfo', !!forceRelay);
      posted = true;
    }
    const transcodeIndex = extractTranscodeIndexFromFileInfo();
    if (transcodeIndex && typeof window.__ttdPostVideoManifest === 'function') {
      console.log('[Transcript Downloader] Constructed oneDrive.transcode index from g_fileInfo:', transcodeIndex);
      window.__ttdPostVideoManifest(transcodeIndex, null, 'g_fileInfo-transcode', !!forceRelay);
      posted = true;
    }
    return posted;
  }

  let transcriptContextPosted = false;
  function tryPostTranscriptContext() {
    if (transcriptContextPosted) return true;
    const g = window.g_fileInfo;
    const spItemUrl = g && g['.spItemUrl'];
    if (!spItemUrl) return false;
    try {
      const u = new URL(spItemUrl);
      const m = u.pathname.match(/^(\/(?:personal|sites|teams)\/[^/]+)\/_api\/v[0-9.]+\/drives\/([^/]+)\/items\/([^/?]+)/);
      if (!m) return false;
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

  function tryPostAll(forceRelay) {
    return tryPostManifest(forceRelay) & tryPostTranscriptContext() ? true : false;
  }

  if (!tryPostAll()) {
    const originalOnLoad = window.OnLoadVideoFileInfo;
    window.OnLoadVideoFileInfo = function() {
      if (originalOnLoad) originalOnLoad.apply(this, arguments);
      tryPostAll();
    };
    window.addEventListener('load', function() {
      setTimeout(tryPostAll, 1000);
    });
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'TTD_REQUEST_CONTEXT') {
      transcriptContextPosted = false;
      tryPostTranscriptContext();
      tryPostManifest(true);
      if (typeof window.__ttdLastPostedManifest === 'function' && window.__ttdLastPostedManifest()) {
        window.__ttdPostVideoManifest(window.__ttdLastPostedManifest(), null, 'cached', true);
      }
      if (typeof window.__ttdLastPostedTranscode === 'function' && window.__ttdLastPostedTranscode()) {
        window.postMessage({
          type: 'VIDEO_TRANSCODE_URL',
          transcodeUrl: window.__ttdLastPostedTranscode()
        }, '*');
      }
    }
    if (event.data && event.data.type === 'TTD_REQUEST_PLAYBACK_AUTH') {
      try {
        const v = document.querySelector('video');
        if (v && v.paused) v.play().catch(function() {});
      } catch (_) { /* ignore */ }
    }
  });
})();
