// Content script that runs on MS Teams/SharePoint pages
// Injects a custom download button next to the disabled download transcript button

(function() {
  'use strict';

  console.debug('[Transcript Downloader] Content script loaded');

  let transcriptUrl = null;
  let transcriptData = null; // Will store the JSON data
  let vttData = null; // Will store converted VTT
  let selectedFormat = 'vtt'; // Default format (json, vtt, or vtt-grouped)
  let videoManifestUrl = null;
  // Bearer token captured from the player's own videomanifest fetch. Microsoft's
  // .svc.ms CDN now requires this `x-spopactoken` header in addition to the
  // P1-P4 query-string signature, otherwise the request returns HTTP 401 with
  // `x-errorcode: NoAccessToken`.
  let videoSpopActoken = null;
  // Bearer token captured from any `/_api/v2.x/...` call the player makes.
  // Replayed on our proactive transcript-metadata fetch so it works in
  // guest/anonymous viewer scenarios where cookie auth alone is refused.
  let spApiBearer = null;

  // Global segment-fetch budget — total in flight across all tracks. SharePoint
  // throttles around the low-teens for many tenants, so default 4 keeps us
  // well under their limit; users can dial up to 16 for lax tenants or down
  // to 1 for flaky / metered networks. 32+ reliably triggered 429s in testing
  // so we cap there. 429s are retried with the Retry-After header (or
  // exponential backoff) by fetchWithRetry. Persisted via chrome.storage.sync.
  let videoDownloadConcurrency = 4;
  const VIDEO_CONCURRENCY_OPTIONS = [1, 2, 4, 8, 16];

  // Inline SVG download glyph (down-arrow into tray) — clearer "downloadable"
  // affordance than emoji icons. Shared by the legacy command-bar button and
  // the floating widget so both feel consistent.
  const DL_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a.75.75 0 0 1 .75.75v6.69l1.97-1.97a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 8.03a.75.75 0 1 1 1.06-1.06l1.97 1.97V2.25A.75.75 0 0 1 8 1.5Z M2.75 12a.75.75 0 0 1 .75.75v.75c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25v-.75a.75.75 0 0 1 1.5 0v.75A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.5v-.75a.75.75 0 0 1 .75-.75Z"/></svg>';

  // Build fetch init for any request to the .svc.ms media CDN, injecting the
  // captured spopactoken bearer when available. Pass through other options.
  function svcMsFetchInit(extra) {
    const init = Object.assign({}, extra || {});
    if (videoSpopActoken) {
      init.headers = Object.assign({}, init.headers || {}, {
        'x-spopactoken': videoSpopActoken
      });
    }
    return init;
  }

  // Listen for messages from the intercept.js script running in MAIN world
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data.type === 'TRANSCRIPT_METADATA') {
      console.log('[Transcript Downloader] Received transcript metadata:', event.data);
      transcriptUrl = event.data.temporaryDownloadUrl;
      updateFloatingWidgetState();
    }

    if (event.data.type === 'SP_API_BEARER') {
      if (event.data.authorization && event.data.authorization !== spApiBearer) {
        spApiBearer = event.data.authorization;
        console.debug('[Transcript Downloader] Captured SharePoint Stream API bearer');
      }
    }

    if (event.data.type === 'VIDEO_MANIFEST_URL') {
      console.log('[Transcript Downloader] Received video manifest URL:', event.data.manifestUrl,
        event.data.spopactoken ? '(with x-spopactoken)' : '(no token)');
      videoManifestUrl = event.data.manifestUrl;
      // Only overwrite the captured token if the new message has one — never
      // downgrade from "token present" to "token missing".
      if (event.data.spopactoken) videoSpopActoken = event.data.spopactoken;
      updateFloatingWidgetState();
    }
  });

  // ============================================================================
  // Format Conversion Functions
  // ============================================================================

  function timeToSeconds(t) {
    const [h, m, s] = t.split(':');
    return Math.round((parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000) / 1000;
  }

  function secondsToVTT(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toFixed(3).padStart(6, '0');
    return `${h}:${m}:${s}`;
  }

  function convertJSONToVTT(transcript) {
    const data = JSON.parse(transcript);
    const entries = data.entries || [];
    let vtt = 'WEBVTT\n\n';
    
    entries.forEach((entry, index) => {
      const start = secondsToVTT(timeToSeconds(entry.startOffset));
      const end = secondsToVTT(timeToSeconds(entry.endOffset));
      const speaker = entry.speakerDisplayName || 'Unknown';
      const text = entry.text || '';
      
      vtt += `${entry.id || index + 1}\n`;
      vtt += `${start} --> ${end}\n`;
      vtt += `<v ${speaker}>${text}\n\n`;
    });
    
    return vtt;
  }

  // Convert JSON to grouped text format
  function convertJSONToGrouped(jsonText) {
    const data = JSON.parse(jsonText);
    const entries = data.entries || [];
    const grouped = [];
    let currentSpeaker = null;
    let bufferText = '';
    
    entries.forEach((entry, i) => {
      const speaker = entry.speakerDisplayName || 'Unknown';
      const text = entry.text || '';
      
      if (speaker !== currentSpeaker) {
        if (bufferText) {
          grouped.push(`${currentSpeaker}: ${bufferText.trim()}`);
        }
        currentSpeaker = speaker;
        bufferText = text;
      } else {
        bufferText += ' ' + text;
      }
    });
    
    // Flush last buffer
    if (bufferText && currentSpeaker) {
      grouped.push(`${currentSpeaker}: ${bufferText.trim()}`);
    }
    
    return grouped.join('\n\n');
  }

  // ============================================================================
  // Modal Management
  // ============================================================================

  // HTML escape function to prevent HTML interpretation in preview boxes
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateButtonText(format) {
    const modalButton = document.querySelector('#modalDownload');
    if (!modalButton) return;
    
    const formatText = {
      'json': 'Download RAW JSON',
      'vtt': 'Download VTT',
      'vtt-grouped': 'Download Grouped VTT'
    };
    
    modalButton.textContent = formatText[format] || 'Download';
  }

  function createFormatSelectionModal() {
    const modal = document.createElement('div');
    modal.id = 'formatSelectionModal';
    
    // Generate JSON preview (first 500 chars) - escape HTML
    const jsonPreview = transcriptData ? escapeHtml(JSON.stringify(JSON.parse(transcriptData), null, 2).substring(0, 500) + '...') : 'Loading preview...';
    
    // Generate preview for VTT (first 500 chars) - escape HTML to show <v Speaker> tags
    const vttPreview = vttData ? escapeHtml(vttData.substring(0, 500) + '...') : 'Loading preview...';
    
    // Generate preview for grouped format - escape HTML
    let groupedPreview = 'Loading preview...';
    if (transcriptData) {
      const grouped = convertJSONToGrouped(transcriptData);
      groupedPreview = escapeHtml(grouped.substring(0, 500) + '...');
    }
    
    // Get auto-detected filename
    const autoTitle = document.title.replace(/[^a-z0-9\s]/gi, '_').trim();
    const displayTitle = autoTitle || '[Not detected]';
    
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Select Transcript Format</h2>
          <button class="modal-close" id="modalClose">&times;</button>
        </div>
        
        <div class="format-options-container">
          <div class="format-option" data-format="json">
            <h3>RAW JSON <span class="format-badge">.json</span></h3>
            <p>Original MS Stream format with full metadata</p>
            <div class="format-sample">${jsonPreview}</div>
          </div>
          
          <div class="format-option" data-format="vtt">
            <h3>VTT <span class="format-badge">.vtt</span></h3>
            <p>Standard WebVTT subtitle format with timestamps</p>
            <div class="format-sample">${vttPreview}</div>
          </div>
          
          <div class="format-option" data-format="vtt-grouped">
            <h3>Grouped VTT <span class="format-badge">.txt</span></h3>
            <p>Optimized for LLMs - consecutive messages grouped by speaker</p>
            <div class="format-sample">${groupedPreview}</div>
          </div>
        </div>
        
        <div class="filename-section">
          <label for="filenameInput" class="filename-label">
            <span class="label-text">Filename:</span>
            <span class="auto-detected">(Auto-detected: ${displayTitle})</span>
          </label>
          <div class="filename-input-container">
            <input 
              type="text" 
              id="filenameInput" 
              class="filename-input" 
              placeholder="Enter filename" 
              value="${autoTitle}"
              required
            />
            <span class="filename-suffix" id="filenameSuffix">_transcript</span>
            <span class="filename-extension" id="filenameExtension">.vtt</span>
          </div>
          <div class="filename-hint">Enter a name for your transcript file</div>
        </div>
        
        <div class="modal-actions">
          <a class="modal-star-link" href="https://github.com/brendangooden/ms-teams-sharepoint-downloader" target="_blank" rel="noopener noreferrer" title="Star this project on GitHub">
            <img class="star-badge" src="https://img.shields.io/github/stars/brendangooden/ms-teams-sharepoint-downloader?style=social&label=Star" alt="Star on GitHub" />
          </a>
          <div class="modal-actions-buttons">
            <button class="modal-button modal-button-cancel" id="modalCancel">Cancel</button>
            <button class="modal-button modal-button-download" id="modalDownload">Download</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    const options = modal.querySelectorAll('.format-option');
    options.forEach(option => {
      option.addEventListener('click', () => {
        options.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        selectedFormat = option.getAttribute('data-format');
        updateButtonText(selectedFormat);
        updateFilenameSuffix(selectedFormat);
        // Persist selection as the new default for next time
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.set({ defaultFormat: selectedFormat });
        }
      });
    });
    
    // Update filename suffix when format changes
    function updateFilenameSuffix(format) {
      const suffixSpan = modal.querySelector('#filenameSuffix');
      const extensionSpan = modal.querySelector('#filenameExtension');
      
      if (format === 'json') {
        suffixSpan.textContent = '_transcript';
        extensionSpan.textContent = '.json';
      } else if (format === 'vtt') {
        suffixSpan.textContent = '_transcript';
        extensionSpan.textContent = '.vtt';
      } else if (format === 'vtt-grouped') {
        suffixSpan.textContent = '_transcript_grouped';
        extensionSpan.textContent = '.txt';
      }
    }
    
    // Select default from storage (first-run default: vtt-grouped)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['defaultFormat'], (result) => {
        const defaultFormat = result.defaultFormat || 'vtt-grouped';
        selectedFormat = defaultFormat;
        modal.querySelector(`[data-format="${defaultFormat}"]`)?.classList.add('selected');
        updateButtonText(defaultFormat);
        updateFilenameSuffix(defaultFormat);
      });
    } else {
      selectedFormat = 'vtt-grouped';
      modal.querySelector('[data-format="vtt-grouped"]')?.classList.add('selected');
      updateButtonText('vtt-grouped');
      updateFilenameSuffix('vtt-grouped');
    }
    
    document.getElementById('modalClose').addEventListener('click', () => {
      modal.classList.remove('show');
    });
    
    document.getElementById('modalCancel').addEventListener('click', () => {
      modal.classList.remove('show');
    });
    
    document.getElementById('modalDownload').addEventListener('click', () => {
      const filenameInput = modal.querySelector('#filenameInput');
      const filename = filenameInput.value.trim();
      
      if (!filename) {
        filenameInput.classList.add('error');
        alert('Please enter a filename');
        return;
      }
      
      filenameInput.classList.remove('error');
      modal.classList.remove('show');
      proceedWithDownload(filename);
    });
    
    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('show');
      }
    });
  }

  function showFormatModal() {
    let modal = document.getElementById('formatSelectionModal');
    if (!modal) {
      createFormatSelectionModal();
      modal = document.getElementById('formatSelectionModal');
    }
    modal.classList.add('show');
  }

  // Function to create and inject the download button
  function injectDownloadButton() {
    // Find the disabled download button container
    const disabledButton = document.querySelector('#downloadTranscript');
    
    if (!disabledButton) {
      return false;
    }

    // Check if we already injected our button
    if (document.querySelector('#customDownloadTranscript')) {
      return true;
    }

    console.debug('[Transcript Downloader] Injecting custom download button');

    // Inject custom styles for the button
    if (!document.querySelector('#transcript-downloader-styles')) {
      const style = document.createElement('style');
      style.id = 'transcript-downloader-styles';
      style.textContent = `
        #downloadTranscript {
          display: none !important;
        }
        
        #customDownloadTranscript {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
          color: white !important;
          border: none !important;
          transition: background 0.3s ease !important;
          cursor: pointer !important;
        }
        
        #customDownloadTranscript:hover {
          background: linear-gradient(135deg, #764ba2 0%, #667eea 100%) !important;
          cursor: pointer !important;
        }
        
        #customDownloadTranscript:active {
          box-shadow: 0 2px 4px rgba(102, 126, 234, 0.4) !important;
        }
        
        #customDownloadTranscript .ms-Button-icon {
          color: white !important;
        }
        
        #customDownloadTranscript .ms-Button-label {
          color: white !important;
          font-weight: 600 !important;
        }
        
        #customDownloadTranscript .ms-Button-menuIcon {
          color: white !important;
        }
      `;
      document.head.appendChild(style);
    }

    // Find the parent container of the overflow set items
    const parentContainer = disabledButton.closest('.ms-OverflowSet-item');
    
    if (!parentContainer || !parentContainer.parentElement) {
      console.error('[Transcript Downloader] Could not find parent container');
      return false;
    }

    // Create a new button container (clone the disabled button structure)
    const newButtonContainer = parentContainer.cloneNode(true);
    
    // Get the button element inside the cloned container
    const newButton = newButtonContainer.querySelector('button');
    
    if (!newButton) {
      console.error('[Transcript Downloader] Could not create button');
      return false;
    }

    // Modify the button properties
    newButton.id = 'customDownloadTranscript';
    newButton.classList.remove('is-disabled');
    newButton.setAttribute('aria-disabled', 'false');
    newButton.setAttribute('aria-label', 'Download Transcript');
    
    // Change the label text
    const labelSpan = newButton.querySelector('.ms-Button-label');
    if (labelSpan) {
      labelSpan.textContent = 'Download Transcript';
    }

    // Remove the tooltip about permissions
    const tooltip = newButtonContainer.querySelector('#transcriptDownloadDisableTooltip');
    if (tooltip) {
      tooltip.remove();
    }

    // Remove the screen reader text about permissions
    const screenReaderText = newButton.querySelector('.ms-Button-screenReaderText');
    if (screenReaderText) {
      screenReaderText.textContent = 'Download transcript';
    }

    // Add click event listener
    newButton.addEventListener('click', handleDownloadClick);

    // Insert the new button after the disabled one
    parentContainer.parentElement.insertBefore(newButtonContainer, parentContainer.nextSibling);

    console.debug('[Transcript Downloader] Custom button injected successfully');
    return true;
  }

  // Derive drive id, item id and site path (/personal/... or /sites/...) from
  // any URL we know about, plus window.location. The videomanifest URL contains
  // the values URL-encoded inside its docid querystring parameter; the host page
  // location gives us the site/personal path.
  function deriveTranscriptContext() {
    let driveId = null, itemId = null, sitePath = null;

    // 1. videomanifest.docid carries the canonical _api/v2.0/drives/{id}/items/{id} path
    if (videoManifestUrl) {
      try {
        const docidRaw = new URL(videoManifestUrl).searchParams.get('docid');
        if (docidRaw) {
          const docUrl = new URL(decodeURIComponent(docidRaw));
          const m = docUrl.pathname.match(/^(\/(?:personal|sites)\/[^/]+)\/_api\/v[0-9.]+\/drives\/([^/]+)\/items\/([^/?]+)/);
          if (m) { sitePath = m[1]; driveId = m[2]; itemId = m[3]; }
        }
      } catch (_) { /* ignore */ }
    }

    // 2. Fall back to current page path for sitePath if not yet known
    if (!sitePath) {
      const m = window.location.pathname.match(/^\/(?:personal|sites)\/[^/]+/);
      if (m) sitePath = m[0];
    }

    return { driveId, itemId, sitePath };
  }

  // Fetch transcript metadata directly from /_api/v2.1/.../media/transcripts.
  // SharePoint Stream only fires this request when the user opens the Transcript
  // panel, so if the user clicks our Download button before doing so we have to
  // fetch it ourselves rather than wait for the intercept hook.
  async function fetchTranscriptUrl() {
    const { driveId, itemId, sitePath } = deriveTranscriptContext();
    if (!driveId || !itemId || !sitePath) {
      console.warn('[Transcript Downloader] Cannot proactively fetch transcript metadata — missing context', { driveId, itemId, sitePath });
      return { status: 'unknown' };
    }

    // Use the item-with-expand shape — same call the player makes via the
    // /v2.1/.../items/{id}?$expand=media/transcripts endpoint. Falls back to
    // the legacy /media/transcripts collection if the expand call returns no
    // useful data.
    const baseUrl = `${window.location.origin}${sitePath}/_api/v2.1/drives/${driveId}/items/${itemId}`;
    const expandUrl = `${baseUrl}?select=media%2Ftranscripts%2CaudioTracks&%24expand=media%2Ftranscripts%2Cmedia%2FaudioTracks`;
    const collectionUrl = `${baseUrl}/media/transcripts`;

    const headers = { 'Accept': 'application/json' };
    if (spApiBearer) headers['Authorization'] = spApiBearer;

    console.log('[Transcript Downloader] Proactively fetching transcript metadata:', expandUrl,
      spApiBearer ? '(with bearer)' : '(cookie auth only)');

    let resp = await fetch(expandUrl, { credentials: 'include', headers });
    if (!resp.ok) {
      console.debug('[Transcript Downloader] Expand call failed, falling back to collection endpoint');
      resp = await fetch(collectionUrl, { credentials: 'include', headers });
    }
    if (!resp.ok) {
      console.error('[Transcript Downloader] Metadata fetch failed:', resp.status, resp.statusText);
      return { status: 'unknown' };
    }
    const data = await resp.json();

    let transcript = null;
    if (data && data.media && Array.isArray(data.media.transcripts) && data.media.transcripts.length > 0) {
      transcript = data.media.transcripts[0];
    } else if (data && Array.isArray(data.value) && data.value.length > 0 && data.value[0].temporaryDownloadUrl) {
      transcript = data.value.find(t => t.isDefault) || data.value[0];
    } else if (data && data.temporaryDownloadUrl) {
      transcript = data;
    }

    if (transcript && transcript.temporaryDownloadUrl) {
      transcriptUrl = transcript.temporaryDownloadUrl;
      updateFloatingWidgetState();
      return { status: 'ok', url: transcriptUrl };
    }

    // Distinguish "API explicitly says no transcripts exist" from "we got back
    // a shape we don't understand". The expand call returns
    // { media: {} } or { media: { transcripts: [] } } for never-transcribed
    // videos; the collection call returns { value: [] }. Both are definitive.
    const definitivelyEmpty =
      (data && data.media && (
        !Array.isArray(data.media.transcripts) ||
        data.media.transcripts.length === 0
      )) ||
      (data && Array.isArray(data.value) && data.value.length === 0);

    console.warn('[Transcript Downloader] Metadata response had no temporaryDownloadUrl', data);
    return { status: definitivelyEmpty ? 'none' : 'unknown' };
  }

  // Handle download button click - show format selection modal
  async function handleDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    console.log('[Transcript Downloader] Download button clicked');

    // If the intercept hook hasn't seen the metadata yet (user hasn't opened the
    // Transcript panel), fetch it ourselves before failing.
    let fetchResult = null;
    if (!transcriptUrl) {
      try {
        fetchResult = await fetchTranscriptUrl();
      } catch (e) {
        console.error('[Transcript Downloader] Proactive metadata fetch errored:', e);
      }
    }

    // Check if we have the transcript URL. If not, surface a loud modal that
    // distinguishes "SharePoint says no transcript exists" from "we couldn't
    // determine it" — much more useful than the previous generic alert.
    if (!transcriptUrl) {
      const status = (fetchResult && fetchResult.status) || 'unknown';
      console.error('[Transcript Downloader] No transcript URL available; status:', status);
      showNoTranscriptWarning(status);
      return;
    }

    try {
      // Fetch the JSON version first (for generating all previews)
      const jsonUrl = transcriptUrl.includes('?') 
        ? `${transcriptUrl}&format=json` 
        : `${transcriptUrl}?format=json`;
      
      console.debug('[Transcript Downloader] Fetching JSON from:', jsonUrl);
      
      const jsonResponse = await fetch(jsonUrl);
      if (!jsonResponse.ok) {
        throw new Error(`HTTP ${jsonResponse.status}: ${jsonResponse.statusText}`);
      }
      
      transcriptData = await jsonResponse.text();
      console.log('[Transcript Downloader] JSON data fetched successfully');
      
      // Convert JSON to VTT for preview
      vttData = convertJSONToVTT(transcriptData);
      console.debug('[Transcript Downloader] VTT conversion complete');

      // Show format selection modal with all previews
      showFormatModal();
      
    } catch (error) {
      console.error('[Transcript Downloader] Error downloading transcript:', error);
      alert('Error downloading transcript: ' + error.message);
    }
  }

  // Proceed with download after format selection
  function proceedWithDownload(customFilename) {
    if (!transcriptData) {
      alert('No transcript data available');
      return;
    }

    let outputData = transcriptData; // JSON by default
    let extension = '.json';
    let suffix = '_transcript';
    
    // Convert based on selected format
    if (selectedFormat === 'vtt') {
      outputData = vttData;
      extension = '.vtt';
      suffix = '_transcript';
    } else if (selectedFormat === 'vtt-grouped') {
      // Convert JSON to grouped format
      outputData = convertJSONToGrouped(transcriptData);
      extension = '.txt';
      suffix = '_transcript_grouped';
    }

    // Use custom filename from modal input
    const sanitizedFilename = customFilename.replace(/[^a-z0-9\s]/gi, '_').toLowerCase();
    const filename = `${sanitizedFilename}${suffix}${extension}`;

    // Download
    downloadDecryptedFile(outputData, filename);
    console.debug('[Transcript Downloader] Download complete!');
  }

  // Download decrypted file. `data` may be a string / Uint8Array / single
  // ArrayBuffer OR an array of buffers (Blob concatenates lazily, avoiding
  // an intermediate big Uint8Array allocation for large video downloads).
  function downloadDecryptedFile(data, filename) {
    const mimeTypes = {
      '.json': 'application/json',
      '.vtt': 'text/vtt',
      '.txt': 'text/plain'
    };
    const ext = filename.substring(filename.lastIndexOf('.'));
    const mimeType = mimeTypes[ext] || 'text/plain';

    const blob = new Blob(Array.isArray(data) ? data : [data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.debug('[Transcript Downloader] File downloaded successfully:', filename);
  }

  // ============================================================================
  // Browser-native DASH Downloader
  // ============================================================================

  function parseDashManifest(xmlText, manifestUrl) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Failed to parse DASH manifest XML');
    }

    // Honor a top-level <BaseURL> if the manifest provides one. Microsoft now
    // returns an absolute BaseURL on the same origin as the page
    // (sharepoint.com/_api_cached/...) which keeps segment fetches inside the
    // browser's same-origin trust zone. Without using it, we'd construct URLs
    // for the manifest's CDN host and get blocked by CORS.
    const baseUrlEl = doc.querySelector('BaseURL');
    const manifestDerivedBase = manifestUrl.split('?')[0].replace(/\/[^/]*$/, '/');
    const baseUrl = (baseUrlEl && baseUrlEl.textContent.trim()) || manifestDerivedBase;

    function toAbsolute(url) {
      if (!url) return '';
      if (/^https:\/\//.test(url)) return url;
      if (/^[a-z][a-z0-9+\-.]*:/i.test(url)) throw new Error('Unsafe URL scheme in manifest: ' + url);
      // URL constructor handles absolute, host-relative, and path-relative bases.
      return new URL(url, baseUrl).href;
    }

    function expandTemplate(tpl, repId, bandwidth, number, time) {
      return tpl
        .replace(/\$RepresentationID\$/g, repId)
        .replace(/\$Bandwidth\$/g, bandwidth)
        .replace(/\$Number%0(\d+)d\$/g, (_, w) => String(number).padStart(parseInt(w, 10), '0'))
        .replace(/\$Number\$/g, String(number))
        .replace(/\$Time\$/g, String(time));
    }

    const adaptationSets = Array.from(doc.querySelectorAll('AdaptationSet'));
    const isMuxed = adaptationSets.length === 1;
    const tracks = [];

    for (const as of adaptationSets) {
      let type = as.getAttribute('contentType') || '';
      if (!type) {
        const mime = as.getAttribute('mimeType') || '';
        type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : '';
      }
      if (isMuxed) type = 'muxed';

      const reps = Array.from(as.querySelectorAll('Representation'))
        .sort((a, b) => parseInt(b.getAttribute('bandwidth') || '0', 10) - parseInt(a.getAttribute('bandwidth') || '0', 10));
      const rep = reps[0];
      if (!rep) continue;

      const repId = rep.getAttribute('id') || '';
      const bandwidth = rep.getAttribute('bandwidth') || '';
      const mimeType = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';

      const segTpl = rep.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');
      if (!segTpl) continue;

      const startNumber = parseInt(segTpl.getAttribute('startNumber') || '1', 10);
      const initTpl = segTpl.getAttribute('initialization') || '';
      const mediaTpl = segTpl.getAttribute('media') || '';
      const initUrl = toAbsolute(expandTemplate(initTpl, repId, bandwidth, startNumber, 0));
      const segments = [];

      const timeline = segTpl.querySelector('SegmentTimeline');
      if (timeline) {
        let t = 0, segNum = startNumber;
        for (const s of timeline.querySelectorAll('S')) {
          const sT = s.getAttribute('t');
          if (sT !== null) t = parseInt(sT, 10);
          const d = parseInt(s.getAttribute('d') || '0', 10);
          const r = parseInt(s.getAttribute('r') || '0', 10);
          for (let i = 0; i <= r; i++) {
            segments.push(toAbsolute(expandTemplate(mediaTpl, repId, bandwidth, segNum, t)));
            t += d;
            segNum++;
          }
        }
      } else {
        const duration = parseInt(segTpl.getAttribute('duration') || '0', 10);
        const timescale = parseInt(segTpl.getAttribute('timescale') || '1', 10);
        const period = as.closest('Period');
        const periodDur = period ? (() => {
          const m = (period.getAttribute('duration') || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
          return m ? parseInt(m[1] || '0') * 3600 + parseInt(m[2] || '0') * 60 + parseFloat(m[3] || '0') : 0;
        })() : 0;
        if (duration > 0 && periodDur > 0) {
          const count = Math.ceil(periodDur / (duration / timescale));
          for (let i = 0; i < count; i++) {
            segments.push(toAbsolute(expandTemplate(mediaTpl, repId, bandwidth, startNumber + i, i * duration)));
          }
        }
      }

      // Extract DASH-SEA AES-128-CBC encryption info per AdaptationSet. SEA
      // (urn:mpeg:dash:sea:2012) is "Segment Encryption Authentication" — it
      // declares per-CryptoPeriod AES keys delivered via plain HTTPS rather
      // than a CDM/EME licence. We can decrypt these client-side. Hard DRM
      // schemes (Widevine/PlayReady/FairPlay UUIDs) are handled separately
      // upstream by the DRM_PROTECTED early-exit in triggerBrowserVideoDownload.
      let encryption = null;
      const seaCp = [...as.querySelectorAll('ContentProtection')].find(cp =>
        cp.getAttribute('schemeIdUri') === 'urn:mpeg:dash:sea:2012'
      );
      if (seaCp) {
        const segEnc = seaCp.querySelector('SegmentEncryption');
        const scheme = segEnc ? segEnc.getAttribute('schemeIdUri') : '';
        const period = seaCp.querySelector('CryptoPeriod');
        const keyUri = period ? period.getAttribute('keyUriTemplate') : null;
        const ivAttr = period ? (period.getAttribute('IV') || '') : '';
        if (/aes128-cbc/i.test(scheme) && keyUri && ivAttr) {
          encryption = {
            scheme: 'aes-128-cbc',
            keyUri,
            iv: hexToBytes(ivAttr.replace(/^0x/i, ''))
          };
        }
      }

      tracks.push({ type, mimeType, initUrl, segments, encryption });
    }

    return tracks;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // Abortable sleep — resolves after `ms` unless `signal` aborts first.
  function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
        return;
      }
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(t);
        reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Fetch with retry on 429/503 + transient network errors. Honours the
  // `Retry-After` header (seconds) if the server sends one; otherwise uses
  // exponential backoff capped at 30s. Gives up after `maxAttempts`. The
  // optional `onThrottle({attempt, delayMs, status})` callback lets the
  // caller surface "throttled, backing off..." in the progress UI.
  async function fetchWithRetry(url, init, signal, onThrottle, maxAttempts = 6) {
    let attempt = 0;
    for (;;) {
      attempt++;
      if (signal && signal.aborted) {
        throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      }
      let resp;
      try {
        resp = await fetch(url, init);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (attempt >= maxAttempts) throw e;
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        if (onThrottle) onThrottle({ attempt, delayMs, status: 0 });
        await abortableSleep(delayMs, signal);
        continue;
      }
      // 429 = throttle; 503 = transient overload. Anything else: surface to caller.
      if ((resp.status === 429 || resp.status === 503) && attempt < maxAttempts) {
        const headerSecs = parseInt(resp.headers.get('Retry-After'), 10);
        const delayMs = Number.isFinite(headerSecs) && headerSecs > 0
          ? Math.min(headerSecs * 1000, 30000)
          : Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        if (onThrottle) onThrottle({ attempt, delayMs, status: resp.status });
        await abortableSleep(delayMs, signal);
        continue;
      }
      return resp;
    }
  }

  async function downloadDashSegments(tracks, onProgress, signal) {
    // Concurrency is a GLOBAL budget across all tracks — picking 8 in the
    // modal means 8 in flight total (not 8 per track). SharePoint's per-IP
    // throttling kicks in around the low-teens for many tenants, so doubling
    // the in-flight count when video-audio runs both tracks at once was
    // hitting 429s.
    const concurrency = videoDownloadConcurrency;

    const totalSegs = tracks.reduce((s, t) => s + (t.initUrl ? 1 : 0) + t.segments.length, 0);
    let done = 0;
    let lastThrottleStatus = null;

    function reportProgress(text) { onProgress(done, totalSegs, text); }
    function noteThrottle({ attempt, delayMs, status }) {
      lastThrottleStatus = `HTTP ${status || 'network'} — backing off ${Math.round(delayMs / 1000)}s (attempt ${attempt})...`;
      reportProgress(lastThrottleStatus);
    }

    // Per-track preamble (encryption key + init segment) runs in parallel
    // across tracks but is exempt from the segment-fetch budget — there are
    // at most 2 inits and 2 key fetches in flight.
    const trackStates = await Promise.all(tracks.map(async (track) => {
      const label = tracks.length > 1 ? ` (${track.type} track)` : '';

      // If this track is SEA-encrypted, fetch the AES-128-CBC key once. The
      // key endpoint lives on the .svc.ms CDN and requires the x-spopactoken
      // bearer; the segment URLs themselves live on sharepoint.com (per the
      // manifest's <BaseURL>) and are same-origin, no extra auth needed.
      let cryptoKey = null;
      if (track.encryption) {
        reportProgress(`Fetching encryption key${label}...`);
        const init = track.encryption.keyUri.includes('svc.ms') && videoSpopActoken
          ? { signal, headers: { 'x-spopactoken': videoSpopActoken } }
          : { signal };
        const keyResp = await fetchWithRetry(track.encryption.keyUri, init, signal, noteThrottle);
        if (!keyResp.ok) throw new Error(`Encryption key fetch failed: HTTP ${keyResp.status}`);
        const keyBuf = await keyResp.arrayBuffer();
        cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
      }

      async function decryptIfNeeded(buf) {
        if (!cryptoKey) return buf;
        return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: track.encryption.iv }, cryptoKey, buf);
      }

      // Init segment must come first in the output array. Plain fetch (no
      // custom headers, no credentials): segments are served from the same
      // origin as the page via the manifest's <BaseURL>, so cookies suffice.
      const orderedBufs = new Array((track.initUrl ? 1 : 0) + track.segments.length);
      let segStart = 0;
      if (track.initUrl) {
        reportProgress(`Fetching init segment${label}...`);
        const r = await fetchWithRetry(track.initUrl, { signal }, signal, noteThrottle);
        if (!r.ok) throw new Error(`Init segment failed: HTTP ${r.status} for ${track.initUrl}`);
        orderedBufs[0] = await decryptIfNeeded(await r.arrayBuffer());
        done++;
        segStart = 1;
      }

      return { track, label, orderedBufs, segStart, decryptIfNeeded };
    }));

    // Flat work queue of (trackState, segmentIndex) pairs across all tracks,
    // drained by a single global concurrency limiter.
    const queue = [];
    for (const st of trackStates) {
      for (let si = 0; si < st.track.segments.length; si++) queue.push({ st, si });
    }
    reportProgress(`Downloading ${queue.length} segments (${concurrency} parallel)...`);

    await new Promise((resolve, reject) => {
      if (queue.length === 0) { resolve(); return; }
      let qIdx = 0, inFlight = 0;
      let rejected = false;

      function launch() {
        while (!rejected && inFlight < concurrency && qIdx < queue.length) {
          if (signal && signal.aborted) {
            rejected = true;
            reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            return;
          }
          const job = queue[qIdx++];
          inFlight++;
          fetchWithRetry(job.st.track.segments[job.si], { signal }, signal, noteThrottle)
            .then(r => {
              if (!r.ok) throw new Error(`Segment failed: HTTP ${r.status} for ${job.st.track.segments[job.si]}`);
              return r.arrayBuffer();
            })
            .then(job.st.decryptIfNeeded)
            .then(buf => {
              if (rejected) return;
              job.st.orderedBufs[job.st.segStart + job.si] = buf;
              done++;
              reportProgress(`Downloading segments... (${done}/${totalSegs})`);
              inFlight--;
              if (inFlight === 0 && qIdx >= queue.length) resolve();
              else launch();
            })
            .catch(err => {
              if (rejected) return;
              rejected = true;
              reject(err);
            });
        }
      }
      launch();
    });

    return trackStates.map(s => s.orderedBufs);
  }

  // Mux separate video and audio fMP4 chunks into a single flat MP4.
  // Off-loads the entire mux pipeline to a Web Worker (src/mux-worker.js) so
  // the UI thread stays responsive on long recordings where mux previously
  // froze the tab for several seconds. Each track is passed as the raw array
  // of decrypted ArrayBuffers (`[init, ...mediaSegments]`) — the worker
  // concatenates internally, avoiding a second copy on the UI thread.
  //
  // Note: Chrome refuses `new Worker('chrome-extension://...')` from a content
  // script because the worker would run in the page's origin, not the
  // extension's. Workaround: fetch the worker source via `chrome.runtime.getURL`
  // (which content scripts CAN do because the file is in
  // web_accessible_resources) and instantiate from a blob URL.
  let _muxWorkerBlobUrl = null;
  async function getMuxWorkerUrl() {
    if (_muxWorkerBlobUrl) return _muxWorkerBlobUrl;
    const resp = await fetch(chrome.runtime.getURL('mux-worker.js'));
    if (!resp.ok) throw new Error(`mux-worker fetch failed: HTTP ${resp.status}`);
    const src = await resp.text();
    _muxWorkerBlobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    return _muxWorkerBlobUrl;
  }

  async function muxTracks(videoChunks, audioChunks, onProgress) {
    const workerUrl = await getMuxWorkerUrl();
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl);
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.progress) {
          onProgress(msg.progress.done, msg.progress.total, msg.progress.text);
        } else if (msg.error) {
          worker.terminate();
          reject(new Error(msg.error));
        } else if (msg.result) {
          worker.terminate();
          resolve(msg.result);
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || 'mux-worker crashed'));
      };

      const videoBufs = videoChunks.map(b => b.slice(0));
      const audioBufs = audioChunks.map(b => b.slice(0));

      try {
        // Use 'video'/'audio' — that's what the worker destructures from event.data
        worker.postMessage({ video: videoBufs, audio: audioBufs });
      } catch (error) {
        worker.terminate();
        reject(error);
      }
    });
  }


  async function triggerBrowserVideoDownload(format, filename, onProgress, signal) {
    onProgress(0, 1, 'Fetching manifest...');
    const resp = await fetch(videoManifestUrl, svcMsFetchInit({ signal }));
    if (!resp.ok) throw new Error(`Manifest fetch failed: HTTP ${resp.status}`);
    const xmlText = await resp.text();

    onProgress(0, 1, 'Parsing manifest...');
    const allTracks = parseDashManifest(xmlText, videoManifestUrl);
    if (!allTracks.length) throw new Error('No tracks found in manifest');

    // Detect TRUE hard-DRM (Widevine / PlayReady / FairPlay) via the
    // ContentProtection schemeIdUri UUIDs. We DON'T fail on bare
    // <ContentProtection> presence — Microsoft applies DASH-SEA (AES-128-CBC
    // with HTTP-fetchable keys, schemeIdUri="urn:mpeg:dash:sea:..." ) to
    // SharePoint Stream videos, which IS still client-decryptable (just not
    // yet implemented here). Only hard CDM-required schemes are unrecoverable.
    const HARD_DRM_SCHEMES = [
      'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
      '9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
      '94ce86fb-07ff-4f43-adb8-93d2fa968ca2'  // FairPlay
    ];
    const cpSchemes = [...xmlText.matchAll(/<ContentProtection\b[^>]*schemeIdUri="([^"]+)"/gi)]
      .map(m => m[1].toLowerCase());
    const hasHardDrm = cpSchemes.some(s =>
      HARD_DRM_SCHEMES.some(uuid => s.includes(uuid))
    );
    if (hasHardDrm) {
      const err = new Error('DRM_PROTECTED');
      err.isDrm = true;
      throw err;
    }

    const videoTrack = allTracks.find(t => t.type === 'video' || t.type === 'muxed');
    const audioTrack = allTracks.find(t => t.type === 'audio');

    let tracksToDownload, isSeparate = false;

    if (format === 'video-audio') {
      if (!audioTrack || allTracks.length === 1) {
        tracksToDownload = [videoTrack || allTracks[0]];
      } else {
        tracksToDownload = [videoTrack, audioTrack].filter(Boolean);
        isSeparate = tracksToDownload.length > 1;
      }
    } else if (format === 'audio-m4a') {
      tracksToDownload = [audioTrack || allTracks[0]];
    } else if (format === 'video-only') {
      tracksToDownload = [videoTrack || allTracks[0]];
    } else {
      throw new Error('Format not supported for browser download: ' + format);
    }

    const safeFilename = filename.replace(/[^a-z0-9\s_-]/gi, '_');
    const trackData = await downloadDashSegments(tracksToDownload, onProgress, signal);

    if (isSeparate) {
      const muxed = await muxTracks(trackData[0], trackData[1], onProgress);
      downloadDecryptedFile(muxed, safeFilename + '.mp4');
      onProgress(1, 1, 'Download complete!');
    } else {
      const ext = format === 'audio-m4a' ? '.m4a' : '.mp4';
      downloadDecryptedFile(trackData[0], safeFilename + ext);
      onProgress(1, 1, 'Download complete!');
    }
  }

  // Surface DRM rejection as a prominent full-screen modal rather than the
  // small inline status line. Microsoft is rolling encryption out to SharePoint
  // Stream videos; once it's on, neither the browser nor any client-side tool
  // can produce a playable file without a DRM licence we can't obtain.
  function showDrmWarning() {
    let overlay = document.getElementById('ttdDrmWarningOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ttdDrmWarningOverlay';
      overlay.innerHTML = `
        <div class="ttd-drm-dialog" role="alertdialog" aria-labelledby="ttdDrmTitle">
          <div class="ttd-drm-icon" aria-hidden="true">&#128274;</div>
          <h2 id="ttdDrmTitle">This video is DRM-protected</h2>
          <p>Microsoft has applied <strong>encryption</strong> to this SharePoint Stream video. The bytes the CDN returns are AES-encrypted and can only be decrypted by the browser's built-in DRM module during playback.</p>
          <p><strong>It cannot be downloaded</strong> by this extension, by ffmpeg, by yt-dlp, or by any other client-side tool. There is no legitimate workaround.</p>
          <p>If the owner intended this video to be downloadable, ask them to upload an unprotected copy or share via OneDrive directly.</p>
          <div class="ttd-drm-actions">
            <button type="button" id="ttdDrmDismiss">OK</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const dismiss = () => overlay.classList.remove('show');
      overlay.querySelector('#ttdDrmDismiss').addEventListener('click', dismiss);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    }
    overlay.classList.add('show');
  }

  // Surface "transcript not available" as a modal that distinguishes the two
  // cases the user actually cares about:
  //   - status='none'    -> SharePoint confirmed no transcript exists for this
  //                         recording. The meeting was never transcribed (or
  //                         transcription is still processing for very recent
  //                         recordings). Nothing the user can do client-side.
  //   - status='unknown' -> we couldn't determine it (missing context, API
  //                         denied us, or unexpected response shape). The user
  //                         can usually fix this by opening the Transcript
  //                         panel on the page so the intercept hook captures
  //                         the metadata directly.
  function showNoTranscriptWarning(status) {
    let overlay = document.getElementById('ttdNoTranscriptOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ttdNoTranscriptOverlay';
      overlay.innerHTML = `
        <div class="ttd-info-dialog" role="alertdialog" aria-labelledby="ttdNoTxTitle">
          <div class="ttd-info-icon" aria-hidden="true">&#128172;</div>
          <h2 id="ttdNoTxTitle"></h2>
          <div id="ttdNoTxBody"></div>
          <div class="ttd-info-actions">
            <button type="button" id="ttdNoTxDismiss">OK</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const dismiss = () => overlay.classList.remove('show');
      overlay.querySelector('#ttdNoTxDismiss').addEventListener('click', dismiss);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    }

    const title = overlay.querySelector('#ttdNoTxTitle');
    const body = overlay.querySelector('#ttdNoTxBody');
    if (status === 'none') {
      title.textContent = 'This meeting has no transcript';
      body.innerHTML =
        '<p>SharePoint Stream confirms <strong>no transcript was generated</strong> for this recording.</p>' +
        '<p>Common reasons:</p>' +
        '<p>&bull; The meeting organiser didn\'t enable transcription before the call started.<br>' +
        '&bull; The recording is very recent and transcription is still processing &mdash; try again in a few minutes.<br>' +
        '&bull; The video isn\'t a meeting recording (e.g. it\'s a plain uploaded MP4), and was never sent through Stream\'s transcription pipeline.</p>' +
        '<p>There is nothing to download.</p>';
    } else {
      title.textContent = 'Couldn\'t find a transcript';
      body.innerHTML =
        '<p>We weren\'t able to confirm whether this video has a transcript.</p>' +
        '<p><strong>Was this meeting transcribed?</strong> If you\'re not sure, try this:</p>' +
        '<p>&bull; Open the <strong>Transcript</strong> tab/panel on the video.<br>' +
        '&bull; If text appears, close this dialog and click Download Transcript again &mdash; we\'ll pick the URL up automatically.<br>' +
        '&bull; If the Transcript tab is missing or empty, the meeting wasn\'t transcribed and there\'s nothing to download.</p>';
    }
    overlay.classList.add('show');
  }

  // ============================================================================
  // Floating Widget (UI-agnostic fallback for new MS Stream UI)
  // ============================================================================
  //
  // Microsoft has been migrating SharePoint Stream to a new UI that no longer
  // exposes `#downloadTranscript` or `.ms-CommandBar-primaryCommand`, so the
  // legacy contextual injections silently no-op. The floating widget is a
  // fixed-position fallback that does not depend on Microsoft's DOM. It hides
  // each button when the corresponding legacy injection has succeeded, so users
  // on the classic UI keep the contextual buttons they're used to.

  function injectFloatingWidget() {
    if (document.getElementById('ttdFloatingWidget')) return true;
    if (!document.body) return false;

    if (!document.querySelector('#ttd-floating-styles')) {
      const style = document.createElement('style');
      style.id = 'ttd-floating-styles';
      style.textContent = `
        #ttdFloatingWidget {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 2147483600;
          display: flex;
          flex-direction: row;
          justify-content: flex-end;
          gap: 8px;
          padding: 6px 16px;
          background: rgba(28, 28, 30, 0.92);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .ttd-floating-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 14px 6px 10px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.25);
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
          cursor: pointer;
          box-shadow: 0 1px 2px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.18);
          transition: transform 0.12s ease, filter 0.12s ease, opacity 0.15s ease, box-shadow 0.12s ease;
          line-height: 1.2;
          height: 30px;
          text-shadow: 0 1px 1px rgba(0,0,0,0.15);
        }
        .ttd-floating-btn:hover {
          transform: translateY(-1px);
          filter: brightness(1.06);
          box-shadow: 0 2px 4px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.22);
        }
        .ttd-floating-btn:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(0,0,0,0.18); }
        .ttd-floating-btn[data-feature="transcript"] {
          background: linear-gradient(135deg, #5b67e0 0%, #6a4ba0 100%);
        }
        .ttd-floating-btn[data-feature="video"] {
          background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
        }
        .ttd-floating-btn[data-state="waiting"] {
          opacity: 0.55;
          cursor: progress;
        }
        .ttd-floating-btn .ttd-dl-arrow {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: 4px;
          background: rgba(255,255,255,0.22);
        }
        .ttd-floating-btn .ttd-dl-arrow svg {
          display: block;
          width: 12px;
          height: 12px;
          fill: #fff;
        }
        .ttd-floating-btn .ttd-dl-label { white-space: nowrap; }
      `;
      document.head.appendChild(style);
    }

    const widget = document.createElement('div');
    widget.id = 'ttdFloatingWidget';
    widget.innerHTML = `
      <button class="ttd-floating-btn" data-feature="transcript" data-state="waiting" type="button">
        <span class="ttd-dl-arrow">${DL_SVG}</span><span class="ttd-dl-label">Download transcript</span>
      </button>
      <button class="ttd-floating-btn" data-feature="video" data-state="waiting" type="button">
        <span class="ttd-dl-arrow">${DL_SVG}</span><span class="ttd-dl-label">Download video</span>
      </button>
    `;
    document.body.appendChild(widget);

    widget.querySelector('[data-feature="transcript"]').addEventListener('click', handleDownloadClick);
    widget.querySelector('[data-feature="video"]').addEventListener('click', handleVideoDownloadClick);

    updateFloatingWidgetState();
    return true;
  }

  // Heuristic: is this page actually a SharePoint Stream / Teams video viewer?
  // The content-script's manifest match pattern is `*.sharepoint.com/*`, which
  // also covers Word/Excel/PowerPoint viewers and the file-browser — places
  // where the floating download widget makes no sense. Gate visibility so the
  // widget only appears on pages that are plausibly a video.
  function isLikelyVideoPage() {
    const loc = window.location;
    const path = (loc.pathname || '').toLowerCase();
    const search = (loc.search || '').toLowerCase();

    // SharePoint Stream / OneDrive video viewer.
    if (path.includes('/stream.aspx')) return true;
    // SharePoint embed page pointing at a video file.
    if (path.includes('/embed.aspx') && /\.(mp4|m4v|mov|webm|avi|mkv)/.test(search)) return true;
    // Teams web shell. The top frame on teams.* is the Teams chrome itself
    // (chat, calendar, app launcher); the actual video viewer always runs in
    // a sub-frame — either a SharePoint stream.aspx iframe (handled by the
    // path check above on that frame's location) or a Teams-internal player.
    // Treating the top frame as a video page surfaces the widget over the
    // Teams chrome where it'll never receive a manifest and stays "disabled".
    if (/^teams\./.test(loc.hostname) && window !== window.top) return true;
    return false;
  }

  // Toggle each floating button's visibility based on whether the legacy
  // contextual button is present (hide if legacy succeeded), whether we're on
  // a page that could plausibly have video/transcript content, and reflect
  // the capture status (waiting/ready) for tooltip-style hinting.
  function updateFloatingWidgetState() {
    const widget = document.getElementById('ttdFloatingWidget');
    if (!widget) return;

    const tBtn = widget.querySelector('[data-feature="transcript"]');
    const vBtn = widget.querySelector('[data-feature="video"]');
    const onVideoPage = isLikelyVideoPage();

    // Each button shows when: legacy not present AND we're on a video page.
    // Do NOT fall back to "URL was captured" — SharePoint site landing pages
    // (e.g. /sites/<name>) can host inline Stream web parts that legitimately
    // fetch videomanifest/transcripts URLs in the top frame. Treating that as
    // "must be a video page" caused the widget to appear as a banner across
    // non-viewer pages.
    let anyVisible = false;

    if (tBtn) {
      const legacyTranscript = document.querySelector('#customDownloadTranscript');
      const show = !legacyTranscript && onVideoPage;
      tBtn.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
      tBtn.setAttribute('data-state', transcriptUrl ? 'ready' : 'waiting');
      tBtn.title = transcriptUrl
        ? 'Download transcript'
        : 'Transcript URL not yet captured — open the Transcript panel or click to try fetching it';
    }
    if (vBtn) {
      const legacyVideo = document.querySelector('#customDownloadVideo');
      const show = !legacyVideo && onVideoPage;
      vBtn.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
      vBtn.setAttribute('data-state', videoManifestUrl ? 'ready' : 'waiting');
      vBtn.title = videoManifestUrl
        ? 'Download video'
        : 'Video manifest URL not yet captured — start playback or wait a moment';
    }

    // Hide the wrapper entirely when no button is visible so it doesn't appear
    // as an empty pill on Word/Excel/PowerPoint pages. When visible, the
    // widget is a full-width top banner — push body content down by exactly
    // the widget's height so SharePoint's UI isn't covered.
    widget.style.display = anyVisible ? '' : 'none';
    if (anyVisible) {
      const h = widget.offsetHeight || 44;
      document.body.style.paddingTop = h + 'px';
    } else {
      document.body.style.paddingTop = '';
    }
  }

  // ============================================================================
  // Video Download Button & Modal
  // ============================================================================

  function injectVideoDownloadButton() {
    // Check if already injected
    if (document.querySelector('#customDownloadVideo')) return true;

    // The `.ms-CommandBar-primaryCommand` selector below also matches the
    // command bar on SharePoint site landing pages and document libraries
    // (e.g. /sites/<name>), where injecting Download buttons is wrong.
    // Gate on the same heuristic the floating widget uses so we only attach
    // to the command bar of an actual Stream/embed/Teams viewer page.
    // Return true to signal "done, don't retry" so the MutationObserver in
    // initialize() can disconnect once the legacy transcript path also
    // resolves (or its 30s timeout fires).
    if (!isLikelyVideoPage()) return true;

    // Place in the top command bar (alongside Upload, Favorites, etc.)
    // rather than inside the transcript panel
    const commandBar = document.querySelector('.ms-CommandBar-primaryCommand');
    if (!commandBar) {
      return false;
    }

    // Find an existing OverflowSet-item in the command bar to clone structure from
    const templateItem = commandBar.querySelector('.ms-OverflowSet-item');
    if (!templateItem) return false;

    // Inject video button styles
    if (!document.querySelector('#video-download-styles')) {
      const style = document.createElement('style');
      style.id = 'video-download-styles';
      style.textContent = `
        #customDownloadVideo {
          background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%) !important;
          color: white !important;
          border: none !important;
          transition: background 0.3s ease !important;
          cursor: pointer !important;
          padding: 0 8px !important;
          height: 32px !important;
          border-radius: 4px !important;
          font-size: 13px !important;
          font-weight: 600 !important;
          display: flex !important;
          align-items: center !important;
          gap: 6px !important;
        }

        #customDownloadVideo:hover {
          background: linear-gradient(135deg, #c0392b 0%, #e74c3c 100%) !important;
        }

        #customDownloadVideo:active {
          box-shadow: 0 2px 4px rgba(231, 76, 60, 0.4) !important;
        }
      `;
      document.head.appendChild(style);
    }

    // Create a new OverflowSet-item container
    const newContainer = document.createElement('div');
    newContainer.className = templateItem.className; // ms-OverflowSet-item item-XX
    newContainer.setAttribute('role', 'none');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'customDownloadVideo';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('aria-label', 'Download Video');
    btn.setAttribute('data-is-focusable', 'true');
    // Match the floating widget's affordance — arrow-into-tray icon then label.
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:rgba(255,255,255,0.22);margin-right:6px;vertical-align:middle;">
        <span style="display:inline-block;width:12px;height:12px;line-height:0;">${DL_SVG.replace('<svg', '<svg style="display:block;width:12px;height:12px;fill:#fff;"')}</span>
      </span>
      <span style="vertical-align:middle;">Download Video</span>
    `;
    btn.addEventListener('click', handleVideoDownloadClick);

    newContainer.appendChild(btn);
    commandBar.appendChild(newContainer);

    console.debug('[Transcript Downloader] Video download button injected into command bar');

    // Also drop the transcript button into the command bar right next to the
    // video button so both live inline together (instead of leaving the
    // transcript button stranded in the floating widget overlay).
    injectTranscriptIntoCommandBar(commandBar, templateItem);

    return true;
  }

  // Sibling injection: places a "Download Transcript" button into the same
  // command-bar OverflowSet right after the video button. Bails if a legacy
  // transcript button (#customDownloadTranscript) already exists from the
  // older `injectDownloadButton()` path that targets `#downloadTranscript`.
  function injectTranscriptIntoCommandBar(commandBar, templateItem) {
    if (document.querySelector('#customDownloadTranscript')) return false;
    if (!commandBar || !templateItem) return false;

    if (!document.querySelector('#transcript-cmdbar-styles')) {
      const style = document.createElement('style');
      style.id = 'transcript-cmdbar-styles';
      style.textContent = `
        #customDownloadTranscript {
          background: linear-gradient(135deg, #5b67e0 0%, #6a4ba0 100%) !important;
          color: white !important;
          border: none !important;
          transition: background 0.3s ease !important;
          cursor: pointer !important;
          padding: 0 8px !important;
          height: 32px !important;
          border-radius: 4px !important;
          font-size: 13px !important;
          font-weight: 600 !important;
          margin: 0 4px !important;
          display: inline-flex !important;
          align-items: center !important;
        }
        #customDownloadTranscript:hover {
          background: linear-gradient(135deg, #6a4ba0 0%, #5b67e0 100%) !important;
        }
      `;
      document.head.appendChild(style);
    }

    const newContainer = document.createElement('div');
    newContainer.className = templateItem.className;
    newContainer.setAttribute('role', 'none');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'customDownloadTranscript';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('aria-label', 'Download Transcript');
    btn.setAttribute('data-is-focusable', 'true');
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:rgba(255,255,255,0.22);margin-right:6px;vertical-align:middle;">
        <span style="display:inline-block;width:12px;height:12px;line-height:0;">${DL_SVG.replace('<svg', '<svg style="display:block;width:12px;height:12px;fill:#fff;"')}</span>
      </span>
      <span style="vertical-align:middle;">Download Transcript</span>
    `;
    btn.addEventListener('click', handleDownloadClick);

    newContainer.appendChild(btn);
    commandBar.appendChild(newContainer);
    console.debug('[Transcript Downloader] Transcript button injected into command bar');
    return true;
  }

  function handleVideoDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    console.log('[Transcript Downloader] Video download button clicked');

    if (!videoManifestUrl) {
      alert('Video manifest URL not captured yet. Please wait a moment and try again, or refresh the page.');
      console.error('[Transcript Downloader] No video manifest URL available');
      return;
    }

    showVideoModal();
  }

  function getVideoFilename() {
    return document.title.replace(/[^a-z0-9\s]/gi, '_').trim() || 'video';
  }

  function createVideoModal() {
    const modal = document.createElement('div');
    modal.id = 'videoDownloadModal';

    const autoFilename = getVideoFilename();

    const browserFormats = [
      { id: 'video-audio', title: 'Video + Audio', badge: '.mp4', icon: '&#127916;' },
      { id: 'audio-m4a', title: 'Audio (M4A)', badge: '.m4a', icon: '&#127925;' },
      { id: 'video-only', title: 'Video Only', badge: '.mp4', icon: '&#127910;' }
    ];

    function renderCards(formats, prefix) {
      return formats.map(f => `
        <div class="video-format-card" data-format="${f.id}" data-prefix="${prefix}">
          <div class="video-format-icon">${f.icon}</div>
          <div class="video-format-info">
            <h3>${f.title} <span class="format-badge video-badge">${f.badge}</span></h3>
          </div>
        </div>
      `).join('');
    }

    modal.innerHTML = `
      <div class="modal-content video-modal-content">
        <div class="modal-header">
          <h2>Download Video</h2>
          <button class="modal-close" id="videoModalClose">&times;</button>
        </div>

        <div class="filename-section">
          <label for="videoFilenameInput" class="filename-label">
            <span class="label-text">Filename:</span>
          </label>
          <div class="filename-input-container">
            <input
              type="text"
              id="videoFilenameInput"
              class="filename-input"
              placeholder="Enter filename"
              value="${escapeHtml(autoFilename)}"
            />
          </div>
        </div>

        <div class="video-format-cards">
          ${renderCards(browserFormats, 'dl')}
        </div>
        <button class="browser-dl-action-btn" id="browserDlActionBtn" disabled>Select a format above</button>
        <div class="browser-download-section" id="browserDownloadSection" style="display: none; margin-top: 12px;">
          <div class="browser-dl-progress-bar-wrap">
            <div class="browser-dl-progress-bar" id="browserDlProgressBar" style="width:0%"></div>
          </div>
          <div class="browser-dl-status" id="browserDlStatus"></div>
        </div>

        <div class="video-parallel-row">
          <label for="videoParallelSelect" class="video-parallel-label">Parallel segment downloads</label>
          <select id="videoParallelSelect" class="video-parallel-select">
            ${VIDEO_CONCURRENCY_OPTIONS.map(n => `<option value="${n}"${n === videoDownloadConcurrency ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
          <span class="video-parallel-hint">total in flight &mdash; higher = faster, but more risk of throttling (429s are auto-retried)</span>
        </div>

        <div class="modal-actions">
          <a class="modal-star-link" href="https://github.com/brendangooden/ms-teams-sharepoint-downloader" target="_blank" rel="noopener noreferrer" title="Star this project on GitHub">
            <img class="star-badge" src="https://img.shields.io/github/stars/brendangooden/ms-teams-sharepoint-downloader?style=social&label=Star" alt="Star on GitHub" />
          </a>
          <div class="modal-actions-buttons">
            <button class="modal-button modal-button-cancel" id="videoModalCancel">Close</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let abortController = null;

    // --- Download logic ---
    const dlCards = modal.querySelectorAll('.video-format-card');
    const dlBtn = modal.querySelector('#browserDlActionBtn');
    let selectedBrowserFormat = null;

    dlCards.forEach(card => {
      card.addEventListener('click', () => {
        dlCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedBrowserFormat = card.getAttribute('data-format');
        dlBtn.disabled = false;
        dlBtn.textContent = '\u2193 Download';
      });
    });

    const defaultCard = modal.querySelector('.video-format-card[data-format="video-audio"]');
    if (defaultCard) {
      defaultCard.classList.add('selected');
      selectedBrowserFormat = 'video-audio';
      dlBtn.disabled = false;
      dlBtn.textContent = '\u2193 Download';
    }

    // Concurrency selector \u2014 reads/writes the module-scoped
    // videoDownloadConcurrency. Persisted in chrome.storage.sync.
    const parallelSel = modal.querySelector('#videoParallelSelect');
    if (parallelSel) {
      parallelSel.addEventListener('change', () => {
        const n = parseInt(parallelSel.value, 10);
        if (VIDEO_CONCURRENCY_OPTIONS.includes(n)) {
          videoDownloadConcurrency = n;
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.set({ videoDownloadConcurrency: n });
          }
        }
      });
    }

    dlBtn.addEventListener('click', async () => {
      if (!selectedBrowserFormat) return;

      if (abortController) {
        abortController.abort();
        return;
      }

      const filename = modal.querySelector('#videoFilenameInput').value.trim() || 'video';
      abortController = new AbortController();
      dlBtn.textContent = 'Cancel Download';
      dlBtn.classList.add('browser-dl-cancelling');
      dlCards.forEach(c => { c.style.pointerEvents = 'none'; c.style.opacity = '0.6'; });

      const section = modal.querySelector('#browserDownloadSection');
      const bar = modal.querySelector('#browserDlProgressBar');
      const status = modal.querySelector('#browserDlStatus');
      section.style.display = '';
      bar.className = 'browser-dl-progress-bar';
      bar.style.width = '0%';
      status.textContent = '';

      try {
        await triggerBrowserVideoDownload(
          selectedBrowserFormat, filename,
          (done, total, text) => {
            bar.style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
            status.textContent = text || '';
          },
          abortController.signal
        );
        bar.style.width = '100%';
        bar.classList.add('browser-dl-complete');
        status.textContent = 'Download complete!';
      } catch (err) {
        if (err.name === 'AbortError') {
          status.textContent = 'Download cancelled.';
        } else if (err.isDrm) {
          // DRM is a hard stop, not an inline error — show the loud popup and
          // reset the progress UI so the user isn't left looking at a half-bar.
          console.error('[Transcript Downloader] DRM-protected video — cannot download');
          status.textContent = 'DRM-protected — cannot download.';
          bar.classList.add('browser-dl-error');
          showDrmWarning();
        } else {
          console.error('[Transcript Downloader] Browser download error:', err);
          let msg = err.message || String(err);
          // Translate the opaque "TypeError: Failed to fetch" from a CORS-blocked
          // segment into something actionable. Common cause: SharePoint Stream
          // tenant policy or guest-viewer session refusing cross-origin segment
          // fetches; the in-tenant player still works because it uses cookies +
          // EME, neither of which a content-script can replicate.
          if (err.name === 'TypeError' && /failed to fetch/i.test(msg)) {
            msg = 'Browser blocked the segment fetch (cross-origin / CORS). ' +
                  'Common when viewing a video as a guest or in a tenant with strict CDN policies. ' +
                  'The native SharePoint player works because it uses the browser\'s DRM module — that path is not available to extensions.';
          }
          status.textContent = 'Error: ' + msg;
          bar.classList.add('browser-dl-error');
        }
      } finally {
        abortController = null;
        dlBtn.textContent = '\u2193 Download';
        dlBtn.classList.remove('browser-dl-cancelling');
        dlCards.forEach(c => { c.style.pointerEvents = ''; c.style.opacity = ''; });
      }
    });

    // Close handlers — abort any in-progress browser download before hiding
    function closeModal() {
      if (abortController) { abortController.abort(); abortController = null; }
      modal.classList.remove('show');
    }

    modal.querySelector('#videoModalClose').addEventListener('click', closeModal);
    modal.querySelector('#videoModalCancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  }

  function showVideoModal() {
    // Remove existing modal so we get fresh closure state each time
    const existing = document.getElementById('videoDownloadModal');
    if (existing) existing.remove();

    createVideoModal();
    document.getElementById('videoDownloadModal').classList.add('show');
  }

  // Monitor for transcript page and inject buttons
  let __ttdInitDone = false;
  let __ttdWatchdogId = null;
  function initialize() {
    if (__ttdInitDone) return;
    __ttdInitDone = true;

    // Pull saved per-track concurrency from sync storage; fall back to the
    // module default if absent or set to an unsupported value.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['videoDownloadConcurrency'], (result) => {
        const saved = parseInt(result.videoDownloadConcurrency, 10);
        if (VIDEO_CONCURRENCY_OPTIONS.includes(saved)) videoDownloadConcurrency = saved;
      });
    }

    injectFloatingWidget();

    let transcriptDone = injectDownloadButton();
    let videoDone = injectVideoDownloadButton();
    updateFloatingWidgetState();

    if (transcriptDone && videoDone) {
      console.debug('[Transcript Downloader] Both legacy buttons injected on initial load');
    } else {
      // Watch for DOM changes until both legacy buttons are injected (or timeout)
      const observer = new MutationObserver(() => {
        // Re-attempt floating widget if document.body wasn't ready earlier
        if (!document.getElementById('ttdFloatingWidget')) injectFloatingWidget();

        if (!transcriptDone) transcriptDone = injectDownloadButton();
        if (!videoDone) videoDone = injectVideoDownloadButton();
        updateFloatingWidgetState();

        if (transcriptDone && videoDone) {
          console.debug('[Transcript Downloader] Both legacy buttons injected after DOM change');
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        observer.disconnect();
      }, 30000);
    }

    // Self-healing watchdog: MS Stream / SharePoint shells re-hydrate and
    // sometimes wipe the floating widget after the MutationObserver above has
    // stopped. A cheap periodic check (every 2s) ensures it comes back. Also
    // re-runs updateFloatingWidgetState so positioning catches up if a legacy
    // command bar appears late.
    if (__ttdWatchdogId !== null) clearInterval(__ttdWatchdogId);
    __ttdWatchdogId = setInterval(() => {
      if (!document.getElementById('ttdFloatingWidget')) injectFloatingWidget();
      else updateFloatingWidgetState();
    }, 2000);
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }

  // Also try when window loads
  window.addEventListener('load', () => {
    setTimeout(initialize, 1000);
  });
})();
