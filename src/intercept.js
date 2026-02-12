// This script runs in the page context to intercept fetch requests
(function() {
  const originalFetch = window.fetch;
  
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0];
    
    // Check if this is the media API metadata call (not the actual VTT content)
    // Only intercept URLs from my-*.sharepoint.com/personal/* to avoid interfering with other SharePoint sites
    if (url && typeof url === 'string' && 
        /https:\/\/[^\/]*-my\.sharepoint\.com\/personal\//.test(url) &&
        url.includes('_api/v2.1/drives') && 
        url.includes('items/') && 
        url.includes('media') && 
        url.includes('transcripts') &&
        !url.includes('/content')) {  // Exclude the actual VTT content endpoint
      
      // Clone the response so we can read it
      const clone = response.clone();
      clone.json().then(data => {
        if (data && data.media && data.media.transcripts && data.media.transcripts.length > 0) {
          const transcript = data.media.transcripts[0];
          window.postMessage({
            type: 'TRANSCRIPT_METADATA',
            temporaryDownloadUrl: transcript.temporaryDownloadUrl,
            displayName: transcript.displayName,
            languageTag: transcript.languageTag
          }, '*');
        }
      }).catch(err => console.error('Error parsing transcript metadata:', err));
    }

    // Detect videomanifest URLs for video download
    if (url && typeof url === 'string' && url.includes('videomanifest')) {
      let manifestUrl = url;
      // Trim URL at index&format=dash if present (keep up to and including that part)
      const dashIndex = manifestUrl.indexOf('index&format=dash');
      if (dashIndex !== -1) {
        manifestUrl = manifestUrl.substring(0, dashIndex + 'index&format=dash'.length);
      }
      console.log('[Transcript Downloader] Detected videomanifest URL:', manifestUrl);
      window.postMessage({
        type: 'VIDEO_MANIFEST_URL',
        manifestUrl: manifestUrl
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
    if (manifestUrl) {
      console.log('[Transcript Downloader] Extracted videomanifest from g_fileInfo:', manifestUrl);
      window.postMessage({
        type: 'VIDEO_MANIFEST_URL',
        manifestUrl: manifestUrl
      }, '*');
      return true;
    }
    return false;
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
