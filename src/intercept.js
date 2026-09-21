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
  const lastPostedTranscodeByTrack = {};
  let lastPostedKey = null;
  let lastPostedCrypto = null;

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
        if (part === 'key' || part === 'cryptokey') return 'key';
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
      if (payload.type === 'VIDEO_CRYPTO') {
        if (payload.iv) root.setAttribute('data-ttd-crypto-iv', payload.iv);
        if (payload.kid) root.setAttribute('data-ttd-crypto-kid', payload.kid);
      }
      if (payload.type === 'VIDEO_KEY_URL' && payload.keyUrl) {
        root.setAttribute('data-ttd-video-key', payload.keyUrl);
      }
    } catch (_) { /* ignore */ }
  }

  function postManifest(rawUrl, spopactoken, source, forceRelay) {
    const kind = classifyMediaUrl(rawUrl);
    if (kind === 'transcode') return postTranscode(rawUrl, spopactoken, source, forceRelay);
    if (kind !== 'manifest' && !(rawUrl && rawUrl.includes('videomanifest'))) return false;

    postCrypto(extractCryptoFromUrl(rawUrl));

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

  function transcodeTrackKey(rawUrl) {
    try {
      return new URL(rawUrl).searchParams.get('track') || 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }

  function postTranscode(rawUrl, spopactoken, source, forceRelay) {
    if (!rawUrl) return false;
    postCrypto(extractCryptoFromUrl(rawUrl));
    const transcodeUrl = stripTempauth(rawUrl);
    const track = transcodeTrackKey(transcodeUrl);
    const isNewTrack = !Object.prototype.hasOwnProperty.call(lastPostedTranscodeByTrack, track);
    lastPostedTranscode = transcodeUrl;
    lastPostedTranscodeByTrack[track] = transcodeUrl;
    if (!isNewTrack && !forceRelay) return true;

    console.log('[Transcript Downloader] Captured transcode session' +
      (source ? ' (' + source + ')' : '') + ': track=' + track);
    relayToContent({
      type: 'VIDEO_TRANSCODE_URL',
      transcodeUrl: transcodeUrl,
      spopactoken: spopactoken || null
    });
    return true;
  }

  function postKeyUrl(rawUrl, spopactoken) {
    if (!rawUrl) return false;
    const keyUrl = stripTempauth(rawUrl);
    if (keyUrl === lastPostedKey && !spopactoken) return true;
    lastPostedKey = keyUrl;
    console.log('[Transcript Downloader] Captured stream key URL');
    relayToContent({
      type: 'VIDEO_KEY_URL',
      keyUrl: keyUrl,
      spopactoken: spopactoken || null
    });
    return true;
  }

  function postDashXml(xmlText, rawUrl, spopactoken) {
    if (!xmlText) return false;
    postCrypto(extractCryptoFromText(xmlText));
    if (!/<MPD[\s>]|<AdaptationSet[\s>]/i.test(xmlText)) return false;
    if (xmlText.length > 3500000) return false;
    relayToContent({
      type: 'VIDEO_DASH_XML',
      xmlText: xmlText,
      manifestUrl: rawUrl ? stripTempauth(rawUrl) : null,
      spopactoken: spopactoken || null
    });
    return true;
  }

  function tryParseJsonObject(s) {
    if (!s || typeof s !== 'string') return null;
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' ? o : null;
    } catch (_) {
      return null;
    }
  }

  function decodeAltManifestMetadata(meta) {
    if (!meta || typeof meta !== 'string') return null;
    let data = tryParseJsonObject(meta);
    if (data) return data;
    try {
      let b64 = meta.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      data = tryParseJsonObject(new TextDecoder().decode(bytes));
      if (data) return data;
    } catch (_) { /* not base64 JSON */ }
    return null;
  }

  function bytesToHex(buf) {
    try {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = '0x';
      for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
      return s;
    } catch (_) {
      return null;
    }
  }

  function cryptoFromMetadataObject(data) {
    if (!data || typeof data !== 'object') return null;
    const iv = data.CryptographicDataIV || data.cryptographicDataIV || data.IV || data.iv ||
      data.CryptographicDataAesIv || null;
    const kid = data.CryptographicDataKid || data.cryptographicDataKid || data.kid || null;
    const key = data.CryptographicDataKey || data.cryptographicDataKey || data.aesKey || null;
    if (!iv && !kid && !key) return null;
    return { iv: iv, kid: kid, keyHex: key };
  }

  function extractCryptoFromText(text) {
    if (!text || typeof text !== 'string') return null;
    let fromObj = cryptoFromMetadataObject(decodeAltManifestMetadata(text));
    if (!fromObj) {
      const alt = text.match(/altManifestMetadata=([^"'&\\]+)/i) ||
        text.match(/"altManifestMetadata"\s*:\s*"([^"]+)"/i);
      if (alt && alt[1]) {
        let raw = alt[1];
        try { raw = decodeURIComponent(raw); } catch (_) { /* already decoded */ }
        fromObj = cryptoFromMetadataObject(decodeAltManifestMetadata(raw));
      }
    }
    const ivMatch = text.match(/CryptographicDataIV["'\s:=]+(0x)?([0-9A-Fa-f]{32})/i) ||
      text.match(/\bIV=["']?(0x)?([0-9A-Fa-f]{32})/i);
    const kidMatch = text.match(/CryptographicDataKid["'\s:=]+["']?([^"'&\s,}]+)/i);
    const iv = (fromObj && fromObj.iv) || (ivMatch ? ((ivMatch[1] || '0x') + ivMatch[2]) : null);
    const kid = (fromObj && fromObj.kid) || (kidMatch ? kidMatch[1] : null);
    if (!iv && !kid) return null;
    return { iv: iv, kid: kid, keyHex: fromObj && fromObj.keyHex };
  }

  function extractCryptoFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const u = new URL(rawUrl);
      const kidFromQs = u.searchParams.get('kid');
      const meta = u.searchParams.get('altManifestMetadata') ||
        u.searchParams.get('AltManifestMetadata');
      const fromMeta = cryptoFromMetadataObject(decodeAltManifestMetadata(meta));
      const iv = fromMeta && fromMeta.iv;
      const kid = (fromMeta && fromMeta.kid) || kidFromQs || null;
      if (!iv && !kid) return extractCryptoFromText(rawUrl);
      return { iv: iv || null, kid: kid, keyHex: fromMeta && fromMeta.keyHex };
    } catch (_) {
      return extractCryptoFromText(rawUrl);
    }
  }

  function postCrypto(crypto, forceRelay) {
    if (!crypto || (!crypto.iv && !crypto.kid && !crypto.keyHex)) return;
    const prev = lastPostedCrypto || {};
    const next = {
      iv: crypto.iv || prev.iv || null,
      kid: crypto.kid || prev.kid || null,
      keyHex: crypto.keyHex || prev.keyHex || null
    };
    if (!forceRelay && lastPostedCrypto &&
        lastPostedCrypto.iv === next.iv &&
        lastPostedCrypto.kid === next.kid &&
        lastPostedCrypto.keyHex === next.keyHex) {
      return;
    }
    lastPostedCrypto = next;
    relayToContent({
      type: 'VIDEO_CRYPTO',
      iv: next.iv,
      kid: next.kid,
      keyHex: next.keyHex
    });
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
    else if (kind === 'key') postKeyUrl(url, token);
    if (token) postSpopActoken(token, source);
  }

  function patchSubtleCrypto(subtle, report) {
    if (!subtle) return;
    const origDecrypt = subtle.decrypt.bind(subtle);
    const origImport = subtle.importKey.bind(subtle);
    let postedIv = false;
    let postedKey = false;
    function decrypt(alg, key, data) {
      try {
        const name = (alg && alg.name) || '';
        if (!postedIv && /AES-CBC/i.test(name) && alg.iv) {
          const iv = bytesToHex(alg.iv);
          if (iv && iv.length === 34) {
            postedIv = true;
            report({ iv: iv });
          }
        }
      } catch (_) { /* ignore */ }
      return origDecrypt.apply(subtle, arguments);
    }
    function importKey(format, keyData, algo, extractable, usages) {
      try {
        const name = (typeof algo === 'string' ? algo : (algo && algo.name)) || '';
        if (!postedKey && format === 'raw' && /AES-CBC/i.test(name) && keyData) {
          const keyHex = bytesToHex(keyData);
          if (keyHex && keyHex.length === 34) {
            postedKey = true;
            report({ keyHex: keyHex });
          }
        }
      } catch (_) { /* ignore */ }
      return origImport.apply(subtle, arguments);
    }
    try {
      subtle.decrypt = decrypt;
      subtle.importKey = importKey;
    } catch (_) {
      try {
        const patched = new Proxy(subtle, {
          get: function(target, prop, receiver) {
            if (prop === 'decrypt') return decrypt;
            if (prop === 'importKey') return importKey;
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          }
        });
        Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: patched });
      } catch (__) { /* ignore */ }
    }
  }

  try {
    patchSubtleCrypto(window.crypto && window.crypto.subtle, function(c) { postCrypto(c); });
  } catch (_) { /* ignore */ }

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

    const kind = classifyMediaUrl(url);
    if (kind === 'manifest' && response && response.ok) {
      response.clone().text().then(function(t) {
        postDashXml(t, url, extractSpopActoken(args));
      }).catch(function() { /* ignore non-text bodies */ });
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
      if (url) {
        handleMediaRequest(String(url), token, 'xhr');
        if (classifyMediaUrl(String(url)) === 'manifest') {
          this.addEventListener('load', function() {
            try {
              if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
              if (this.responseText) postDashXml(this.responseText, String(url), token);
            } catch (_) { /* ignore */ }
          });
        }
      }
      return origSend.apply(this, arguments);
    };
  } catch (_) { /* ignore */ }

  // BroadcastChannel is visible across dedicated workers and this page world
  // without colliding with OnePlayer's own worker.postMessage protocol.
  try {
    const bc = new BroadcastChannel(TTD_CHANNEL);
    bc.onmessage = function(ev) {
      const d = ev.data;
      if (!d) return;
      if (d.xml) postDashXml(d.xml, d.url, d.spopactoken || null);
      if (d.meta) postCrypto(extractCryptoFromText(d.meta));
      if (d.iv || d.keyHex) postCrypto({ iv: d.iv || null, keyHex: d.keyHex || null });
      if (!d.url) return;
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
    'function hx(b){try{var u=b instanceof Uint8Array?b:new Uint8Array(b),s="0x",i=0;for(;i<u.length;i++)s+=("0"+u[i].toString(16)).slice(-2);return s;}catch(e){return null;}}',
    'try{var st=crypto.subtle,od=st.decrypt.bind(st),oi=st.importKey.bind(st),didIv=0,didKey=0;st.decrypt=function(a,k,d){try{if(!didIv&&a&&/AES-CBC/i.test(a.name||"")&&a.iv){var iv=hx(a.iv);if(iv&&iv.length===34){didIv=1;ch.postMessage({iv:iv,source:"worker-subtle"});}}}catch(e){}return od.apply(st,arguments);};st.importKey=function(f,kd,al,ex,us){try{var n=(typeof al==="string"?al:(al&&al.name))||"";if(!didKey&&f==="raw"&&/AES-CBC/i.test(n)&&kd){var kh=hx(kd);if(kh&&kh.length===34){didKey=1;ch.postMessage({keyHex:kh,source:"worker-key"});}}}catch(e){}return oi.apply(st,arguments);};}catch(e){}',
    'var of=self.fetch;self.fetch=function(){var u=fromArgs(arguments),tok=tokFromArgs(arguments);report(u,tok);return of.apply(this,arguments).then(function(r){try{if(u&&(/part=index/i.test(u)||/videomanifest/i.test(u)||/altManifestMetadata=/i.test(u))){r.clone().text().then(function(t){try{if(!t||t.length>3500000)return;if(/<MPD[\\s>]/i.test(t))ch.postMessage({url:u,xml:t,spopactoken:tok,source:"worker-xml"});else if(/CryptographicDataIV/i.test(t))ch.postMessage({url:u,meta:t.slice(0,200000),spopactoken:tok,source:"worker-meta"});}catch(e){}});} }catch(e){}return r;});};',
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
  window.__ttdLastPostedTranscodes = function() {
    const out = [];
    for (const k in lastPostedTranscodeByTrack) {
      if (Object.prototype.hasOwnProperty.call(lastPostedTranscodeByTrack, k)) {
        out.push(lastPostedTranscodeByTrack[k]);
      }
    }
    return out;
  };
  window.__ttdLastPostedKey = function() { return lastPostedKey; };
  window.__ttdPostCrypto = postCrypto;
  window.__ttdLastPostedCrypto = function() { return lastPostedCrypto; };
  window.__ttdExtractCryptoFromUrl = extractCryptoFromUrl;
  window.__ttdExtractCryptoFromText = extractCryptoFromText;
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
    try {
      const g = window.g_fileInfo;
      const transformUrl = g && (g['.transformUrl'] || g['.providerCdnTransformUrl']);
      if (transformUrl && typeof window.__ttdPostCrypto === 'function') {
        const fromUrl = typeof window.__ttdExtractCryptoFromUrl === 'function'
          ? window.__ttdExtractCryptoFromUrl(transformUrl)
          : null;
        if (fromUrl) window.__ttdPostCrypto(fromUrl, !!forceRelay);
        let fromFile = null;
        try {
          fromFile = typeof window.__ttdExtractCryptoFromText === 'function'
            ? window.__ttdExtractCryptoFromText(JSON.stringify(g))
            : null;
        } catch (_) { /* ignore */ }
        if (fromFile) window.__ttdPostCrypto(fromFile, !!forceRelay);
        if (!forceRelay && !((fromUrl && fromUrl.iv) || (fromFile && fromFile.iv))) {
          const hasAlt = /altManifestMetadata=/i.test(transformUrl);
          console.log('[Transcript Downloader] g_fileInfo has no IV yet (altManifestMetadata=' + hasAlt + ')');
        }
      }
    } catch (_) { /* ignore */ }
    const manifestUrl = extractManifestFromFileInfo();
    if (manifestUrl && typeof window.__ttdPostVideoManifest === 'function') {
      console.log('[Transcript Downloader] Extracted videomanifest from g_fileInfo (tempauth stripped):', manifestUrl);
      window.__ttdPostVideoManifest(manifestUrl, null, 'g_fileInfo', !!forceRelay);
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
      const transcodes = typeof window.__ttdLastPostedTranscodes === 'function'
        ? window.__ttdLastPostedTranscodes()
        : (typeof window.__ttdLastPostedTranscode === 'function' && window.__ttdLastPostedTranscode()
          ? [window.__ttdLastPostedTranscode()] : []);
      transcodes.forEach(function(url) {
        window.postMessage({ type: 'VIDEO_TRANSCODE_URL', transcodeUrl: url }, '*');
      });
      if (typeof window.__ttdLastPostedKey === 'function' && window.__ttdLastPostedKey()) {
        window.postMessage({ type: 'VIDEO_KEY_URL', keyUrl: window.__ttdLastPostedKey() }, '*');
      }
      if (typeof window.__ttdLastPostedCrypto === 'function' && window.__ttdLastPostedCrypto()) {
        window.__ttdPostCrypto(window.__ttdLastPostedCrypto(), true);
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
