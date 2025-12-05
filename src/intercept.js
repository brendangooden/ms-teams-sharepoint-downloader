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
    
    return response;
  };
})();
