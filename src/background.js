// Background service worker for MS Teams Transcript Downloader
// Intercepts network requests to capture transcript URLs

console.log('[MS Teams Transcript Downloader] Background script loaded');

let transcriptUrl = null;
let temporaryDownloadUrl = null;
let videoManifestUrl = null;

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  console.log('[Transcript Downloader] Received message:', request.action);

  if (request.action === 'setTranscriptMetadata') {
    // Content script sends us the transcript metadata it captured
    temporaryDownloadUrl = request.temporaryDownloadUrl;
    transcriptUrl = request.temporaryDownloadUrl;
    console.log('[Transcript Downloader] Stored transcript URL:', temporaryDownloadUrl);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'setVideoManifestUrl') {
    videoManifestUrl = request.manifestUrl;
    console.log('[Transcript Downloader] Stored video manifest URL:', videoManifestUrl);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getStatus') {
    sendResponse({
      hasTranscriptUrl: !!transcriptUrl,
      hasVideoManifestUrl: !!videoManifestUrl
    });
    return true;
  }
});

// Listen for extension installation or update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Transcript Downloader] Extension installed');
  } else if (details.reason === 'update') {
    console.log('[Transcript Downloader] Extension updated');
  }
});
