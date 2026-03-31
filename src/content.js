// Content script that runs on MS Teams/SharePoint pages
// Injects a custom download button next to the disabled download transcript button

(function() {
  'use strict';

  console.log('[MS Teams Transcript Downloader] Content script loaded');

  let transcriptUrl = null;
  let transcriptData = null; // Will store the JSON data
  let vttData = null; // Will store converted VTT
  let selectedFormat = 'vtt'; // Default format (json, vtt, or vtt-grouped)
  let videoManifestUrl = null;

  // Listen for messages from the intercept.js script running in MAIN world
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data.type === 'TRANSCRIPT_METADATA') {
      console.log('[Transcript Downloader] Received transcript metadata:', event.data);
      transcriptUrl = event.data.temporaryDownloadUrl;

      // Send to background script (only content.js can access chrome APIs)
      if (chrome && chrome.runtime) {
        chrome.runtime.sendMessage({
          action: 'setTranscriptMetadata',
          temporaryDownloadUrl: event.data.temporaryDownloadUrl
        });
      }
    }

    if (event.data.type === 'VIDEO_MANIFEST_URL') {
      console.log('[Transcript Downloader] Received video manifest URL:', event.data.manifestUrl);
      videoManifestUrl = event.data.manifestUrl;

      if (chrome && chrome.runtime) {
        chrome.runtime.sendMessage({
          action: 'setVideoManifestUrl',
          manifestUrl: event.data.manifestUrl
        });
      }
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
          <button class="modal-button modal-button-cancel" id="modalCancel">Cancel</button>
          <button class="modal-button modal-button-download" id="modalDownload">Download</button>
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
    
    // Select default from storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['defaultFormat'], (result) => {
        const defaultFormat = result.defaultFormat || 'vtt';
        selectedFormat = defaultFormat;
        modal.querySelector(`[data-format="${defaultFormat}"]`)?.classList.add('selected');
        updateButtonText(defaultFormat);
      });
    } else {
      // Fallback if chrome.storage is not available
      selectedFormat = 'vtt';
      modal.querySelector('[data-format="vtt"]')?.classList.add('selected');
      updateButtonText('vtt');
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
      console.debug('[Transcript Downloader] Download button not found yet, will retry...');
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

  // Handle download button click - show format selection modal
  async function handleDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    console.log('[Transcript Downloader] Download button clicked');

    // Check if we have the transcript URL
    if (!transcriptUrl) {
      alert('Transcript URL not captured yet. Please wait a moment and try again, or refresh the page.');
      console.error('[Transcript Downloader] No transcript URL available');
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

  // Download decrypted file
  function downloadDecryptedFile(data, filename) {
    const mimeTypes = {
      '.json': 'application/json',
      '.vtt': 'text/vtt',
      '.txt': 'text/plain'
    };
    const ext = filename.substring(filename.lastIndexOf('.'));
    const mimeType = mimeTypes[ext] || 'text/plain';
    
    const blob = new Blob([data], { type: mimeType });
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

    const baseUrl = manifestUrl.split('?')[0].replace(/\/[^/]*$/, '/');

    function toAbsolute(url) {
      if (!url) return '';
      if (/^https:\/\//.test(url)) return url;
      if (/^[a-z][a-z0-9+\-.]*:/i.test(url)) throw new Error('Unsafe URL scheme in manifest: ' + url);
      return baseUrl + url;
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

      tracks.push({ type, mimeType, initUrl, segments });
    }

    return tracks;
  }

  async function downloadDashSegments(tracks, onProgress, signal) {
    const CONCURRENCY = 8;

    function concatBuffers(bufs) {
      const total = bufs.reduce((s, b) => s + b.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const b of bufs) { out.set(new Uint8Array(b), offset); offset += b.byteLength; }
      return out;
    }

    const totalSegs = tracks.reduce((s, t) => s + (t.initUrl ? 1 : 0) + t.segments.length, 0);
    let done = 0;
    const results = [];

    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const label = tracks.length > 1 ? ` (${track.type} track)` : '';
      const initBufs = [];

      // Init segment must come first — fetch sequentially before media segments
      if (track.initUrl) {
        onProgress(done, totalSegs, `Fetching init segment${label}...`);
        const r = await fetch(track.initUrl, { signal });
        if (!r.ok) throw new Error(`Init segment failed: HTTP ${r.status}`);
        initBufs.push(await r.arrayBuffer());
        done++;
      }

      // Fetch media segments in parallel, storing results by index to preserve order
      const segBufs = new Array(track.segments.length);
      onProgress(done, totalSegs, `Downloading ${track.segments.length} segments${label}...`);

      await new Promise((resolve, reject) => {
        if (track.segments.length === 0) { resolve(); return; }
        let qIdx = 0, inFlight = 0;

        function launch() {
          while (inFlight < CONCURRENCY && qIdx < track.segments.length) {
            if (signal && signal.aborted) {
              reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
              return;
            }
            const idx = qIdx++;
            inFlight++;
            fetch(track.segments[idx], { signal })
              .then(r => {
                if (!r.ok) throw new Error(`Segment ${idx + 1} failed: HTTP ${r.status}`);
                return r.arrayBuffer();
              })
              .then(buf => {
                segBufs[idx] = buf;
                done++;
                onProgress(done, totalSegs, `Downloading segments${label}... (${done}/${totalSegs})`);
                inFlight--;
                if (inFlight === 0 && qIdx >= track.segments.length) resolve();
                else launch();
              })
              .catch(reject);
          }
        }
        launch();
      });

      results.push(concatBuffers([...initBufs, ...segBufs]));
    }

    return results;
  }

  // Mux separate video and audio fMP4 buffers into a single MP4.
  // Strategy: build combined moov (video moov + audio trak/trex spliced in),
  // then create combined fragments where each moof contains two traf boxes
  // (video + audio) and each mdat contains both tracks' data.
  // This standard fMP4 pattern is compatible with VLC and other players.
  async function muxTracks(videoUint8, audioUint8, onProgress) {
    function readU32(b, off) {
      return ((b[off] << 24) | (b[off+1] << 16) | (b[off+2] << 8) | b[off+3]) >>> 0;
    }
    function writeU32(b, off, val) {
      b[off] = (val >>> 24) & 0xFF; b[off+1] = (val >>> 16) & 0xFF;
      b[off+2] = (val >>> 8) & 0xFF; b[off+3] = val & 0xFF;
    }
    function btype(b, off) {
      return String.fromCharCode(b[off], b[off+1], b[off+2], b[off+3]);
    }
    function cat(...arrays) {
      const out = new Uint8Array(arrays.reduce((s, a) => s + a.byteLength, 0));
      let o = 0; for (const a of arrays) { out.set(a, o); o += a.byteLength; }
      return out;
    }

    // Scan bytes starting at startOff and return first box with matching type
    // maxOff limits the search to within a parent box's content
    function findBox(b, type, startOff = 0, maxOff = b.length) {
      let pos = startOff;
      while (pos + 8 <= maxOff) {
        const size = readU32(b, pos);
        if (size < 8) break;
        if (btype(b, pos + 4) === type) return { offset: pos, size };
        pos += size;
      }
      return null;
    }

    onProgress(0, 1, 'Muxing tracks...');

    // ---- Extract moov from each input ----
    const vMoovBox = findBox(videoUint8, 'moov');
    const aMoovBox = findBox(audioUint8, 'moov');
    if (!vMoovBox) throw new Error('No moov found in video buffer');
    if (!aMoovBox) throw new Error('No moov found in audio buffer');

    const vMoov = videoUint8.slice(vMoovBox.offset, vMoovBox.offset + vMoovBox.size);
    const aMoov = audioUint8.slice(aMoovBox.offset, aMoovBox.offset + aMoovBox.size);

    // ---- Extract audio trak, patch tkhd.track_id = 2 ----
    const aTrakBox = findBox(aMoov, 'trak', 8);
    if (!aTrakBox) throw new Error('No trak in audio moov');
    const aTrak = new Uint8Array(aMoov.slice(aTrakBox.offset, aTrakBox.offset + aTrakBox.size));
    const aTkhdBox = findBox(aTrak, 'tkhd', 8);
    if (aTkhdBox) {
      // tkhd full-box: header(8) + version(1) + flags(3) + times(v=0:8, v=1:16) + track_id(4)
      const v = aTrak[aTkhdBox.offset + 8];
      writeU32(aTrak, aTkhdBox.offset + (v === 1 ? 28 : 20), 2);
    }

    // ---- Extract audio trex, patch track_id = 2 (or build minimal one) ----
    let aTrex;
    const aMvexBox = findBox(aMoov, 'mvex', 8);
    if (aMvexBox) {
      const aTrexBox = findBox(aMoov, 'trex', aMvexBox.offset + 8);
      if (aTrexBox) {
        aTrex = new Uint8Array(aMoov.slice(aTrexBox.offset, aTrexBox.offset + aTrexBox.size));
        writeU32(aTrex, 12, 2); // trex: header(8)+version+flags(4)+track_id(4)
      }
    }
    if (!aTrex) {
      aTrex = new Uint8Array([
        0x00,0x00,0x00,0x20, 0x74,0x72,0x65,0x78, // size=32, 'trex'
        0x00,0x00,0x00,0x00,                       // version+flags
        0x00,0x00,0x00,0x02,                       // track_id=2
        0x00,0x00,0x00,0x01,                       // default_sample_description_index=1
        0x00,0x00,0x00,0x00,                       // default_sample_duration
        0x00,0x00,0x00,0x00,                       // default_sample_size
        0x00,0x00,0x00,0x00,                       // default_sample_flags
      ]);
    }

    // ---- Build combined moov ----
    // Take the video moov verbatim (avcC/hvcC/esds all preserved perfectly),
    // patch mvhd.next_track_id = 3, insert aTrak + expand mvex with aTrex.
    const workMoov = new Uint8Array(vMoov);

    // Patch mvhd.next_track_id
    // mvhd offsets: header(8)+fullbox(4)+times(v=0:8,v=1:16)+timescale(4)+duration(v=0:4,v=1:8)
    //              +rate(4)+volume(2)+reserved(2+8)+matrix(36)+pre_defined(24) => next_track_id
    // v=0: 8+4+4+4+4+4+4+2+2+8+36+24 = 104
    // v=1: 8+4+8+8+4+8+4+2+2+8+36+24 = 116
    const vMvhdBox = findBox(workMoov, 'mvhd', 8);
    if (vMvhdBox) {
      const v = workMoov[vMvhdBox.offset + 8];
      writeU32(workMoov, vMvhdBox.offset + (v === 1 ? 116 : 104), 3);
    }

    const vMvexBox = findBox(workMoov, 'mvex', 8);
    let combinedMoov;

    if (vMvexBox) {
      // Expand existing mvex with aTrex
      const oldMvex = workMoov.slice(vMvexBox.offset, vMvexBox.offset + vMvexBox.size);
      const newMvex = cat(oldMvex, aTrex);
      writeU32(newMvex, 0, newMvex.length);

      // Insert aTrak before mvex, swap in newMvex
      const beforeMvex  = workMoov.slice(8, vMvexBox.offset);
      const afterMvex   = workMoov.slice(vMvexBox.offset + vMvexBox.size);
      const moovContent = cat(beforeMvex, aTrak, newMvex, afterMvex);
      combinedMoov = new Uint8Array(8 + moovContent.length);
      writeU32(combinedMoov, 0, combinedMoov.length);
      combinedMoov.set([0x6D,0x6F,0x6F,0x76], 4); // 'moov'
      combinedMoov.set(moovContent, 8);
    } else {
      // No mvex -- build one with video trex(id=1) + audio trex(id=2)
      const vTrex = new Uint8Array([
        0x00,0x00,0x00,0x20, 0x74,0x72,0x65,0x78,
        0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x01,
        0x00,0x00,0x00,0x01, 0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      ]);
      const mvexContent = cat(vTrex, aTrex);
      const mvex = new Uint8Array(8 + mvexContent.length);
      writeU32(mvex, 0, mvex.length);
      mvex.set([0x6D,0x76,0x65,0x78], 4); // 'mvex'
      mvex.set(mvexContent, 8);

      const moovContent = cat(workMoov.slice(8), aTrak, mvex);
      combinedMoov = new Uint8Array(8 + moovContent.length);
      writeU32(combinedMoov, 0, combinedMoov.length);
      combinedMoov.set([0x6D,0x6F,0x6F,0x76], 4); // 'moov'
      combinedMoov.set(moovContent, 8);
    }

    // ---- Defragment: convert fragmented MP4 to flat (non-fragmented) MP4 ----
    // This produces the same format as "ffmpeg -c copy" and is fully compatible
    // with VLC seeking, unlike fragmented MP4 which VLC handles poorly.

    // Collect moof+mdat from each input
    function collectFragments(bytes) {
      const frags = [];
      let pos = 0;
      while (pos + 8 <= bytes.length) {
        const size = readU32(bytes, pos);
        if (size < 8) break;
        if (btype(bytes, pos + 4) === 'moof') {
          let trafData = null;
          let mp = pos + 8;
          while (mp + 8 <= pos + size) {
            const csz = readU32(bytes, mp);
            if (csz < 8) break;
            if (btype(bytes, mp + 4) === 'traf') {
              trafData = bytes.slice(mp, mp + csz);
              break;
            }
            mp += csz;
          }
          const nextPos = pos + size;
          let mdatPayload = null;
          if (nextPos + 8 <= bytes.length && btype(bytes, nextPos + 4) === 'mdat') {
            const mdatSize = readU32(bytes, nextPos);
            mdatPayload = bytes.slice(nextPos + 8, nextPos + mdatSize);
          }
          if (trafData && mdatPayload) frags.push({ traf: trafData, mdatPayload });
        }
        pos += size;
      }
      return frags;
    }

    // Parse traf to extract per-sample info: [{size, duration, flags, ctsOffset}]
    function parseTrafSamples(trafBytes) {
      let defDur = 0, defSize = 0, defFlags = 0;
      const samples = [];
      let pos = 8;
      while (pos + 8 <= trafBytes.length) {
        const sz = readU32(trafBytes, pos);
        if (sz < 8) break;
        const t = btype(trafBytes, pos + 4);
        if (t === 'tfhd') {
          const fl = ((trafBytes[pos+9]<<16)|(trafBytes[pos+10]<<8)|trafBytes[pos+11])>>>0;
          let o = pos + 16;
          if (fl & 1) o += 8;   // base_data_offset
          if (fl & 2) o += 4;   // sample_description_index
          if (fl & 8) { defDur = readU32(trafBytes, o); o += 4; }
          if (fl & 0x10) { defSize = readU32(trafBytes, o); o += 4; }
          if (fl & 0x20) { defFlags = readU32(trafBytes, o); o += 4; }
        }
        if (t === 'trun') {
          const fl = ((trafBytes[pos+9]<<16)|(trafBytes[pos+10]<<8)|trafBytes[pos+11])>>>0;
          const cnt = readU32(trafBytes, pos + 12);
          let o = pos + 16;
          if (fl & 1) o += 4; // data_offset
          let firstFlags = defFlags;
          if (fl & 4) { firstFlags = readU32(trafBytes, o); o += 4; }
          for (let i = 0; i < cnt; i++) {
            let dur = defDur, size = defSize, flags = (i === 0) ? firstFlags : defFlags, cts = 0;
            if (fl & 0x100) { dur = readU32(trafBytes, o); o += 4; }
            if (fl & 0x200) { size = readU32(trafBytes, o); o += 4; }
            if (fl & 0x400) { flags = readU32(trafBytes, o); o += 4; }
            if (fl & 0x800) { cts = readU32(trafBytes, o); o += 4; }
            samples.push({ duration: dur, size, flags, ctsOffset: cts });
          }
        }
        pos += sz;
      }
      return samples;
    }

    const vFrags = collectFragments(videoUint8);
    const aFrags = collectFragments(audioUint8);

    // Parse all samples
    const vSamples = vFrags.flatMap(f => parseTrafSamples(f.traf));
    const aSamples = aFrags.flatMap(f => parseTrafSamples(f.traf));

    // Concatenate all sample data per track
    const vData = cat(...vFrags.map(f => f.mdatPayload));
    const aData = cat(...aFrags.map(f => f.mdatPayload));

    onProgress(0, 1, 'Building MP4...');

    // ---- Helper: build MP4 box ----
    function makeBox(type, ...contents) {
      const totalContent = contents.reduce((s, c) => s + c.byteLength, 0);
      const box = new Uint8Array(8 + totalContent);
      writeU32(box, 0, box.length);
      for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i);
      let off = 8;
      for (const c of contents) { box.set(c, off); off += c.byteLength; }
      return box;
    }

    function makeFullBox(type, version, flags, content) {
      const vf = new Uint8Array(4);
      vf[0] = version;
      vf[1] = (flags >> 16) & 0xFF; vf[2] = (flags >> 8) & 0xFF; vf[3] = flags & 0xFF;
      return makeBox(type, vf, content);
    }

    // ---- Build sample table boxes for a track ----
    function buildStts(samples) {
      // Run-length encode durations
      const runs = [];
      for (const s of samples) {
        if (runs.length > 0 && runs[runs.length - 1].dur === s.duration) {
          runs[runs.length - 1].count++;
        } else {
          runs.push({ count: 1, dur: s.duration });
        }
      }
      const data = new Uint8Array(4 + 4 + runs.length * 8);
      // version=0, flags=0 (first 4 bytes = 0)
      writeU32(data, 4, runs.length);
      for (let i = 0; i < runs.length; i++) {
        writeU32(data, 8 + i * 8, runs[i].count);
        writeU32(data, 12 + i * 8, runs[i].dur);
      }
      return makeBox('stts', data);
    }

    function buildStsz(samples) {
      // Check if all same size
      const allSame = samples.length > 0 && samples.every(s => s.size === samples[0].size);
      const data = new Uint8Array(4 + 4 + 4 + (allSame ? 0 : samples.length * 4));
      // version=0, flags=0
      writeU32(data, 4, allSame ? samples[0].size : 0); // sample_size (0 = variable)
      writeU32(data, 8, samples.length);
      if (!allSame) {
        for (let i = 0; i < samples.length; i++) {
          writeU32(data, 12 + i * 4, samples[i].size);
        }
      }
      return makeBox('stsz', data);
    }

    function buildStsc() {
      // One chunk per track containing all samples
      const data = new Uint8Array(4 + 4 + 12);
      writeU32(data, 4, 1); // entry_count
      writeU32(data, 8, 1); // first_chunk
      writeU32(data, 12, 0); // samples_per_chunk (placeholder, patched below)
      writeU32(data, 16, 1); // sample_description_index
      return makeBox('stsc', data);
    }

    function buildStco() {
      // One chunk offset (placeholder, patched after moov size is known)
      const data = new Uint8Array(4 + 4 + 4);
      writeU32(data, 4, 1); // entry_count
      writeU32(data, 8, 0); // chunk_offset (placeholder)
      return makeBox('stco', data);
    }

    function buildStss(samples) {
      // Sync sample table: sample numbers (1-based) where sample is a keyframe
      // A sample is sync if sample_is_non_sync_sample bit (bit 16 = 0x10000) is NOT set
      const syncIndices = [];
      for (let i = 0; i < samples.length; i++) {
        if (!(samples[i].flags & 0x10000)) syncIndices.push(i + 1);
      }
      const data = new Uint8Array(4 + 4 + syncIndices.length * 4);
      writeU32(data, 4, syncIndices.length);
      for (let i = 0; i < syncIndices.length; i++) {
        writeU32(data, 8 + i * 4, syncIndices[i]);
      }
      return makeBox('stss', data);
    }

    function buildCtts(samples) {
      // Composition time offset table (only if any sample has non-zero ctsOffset)
      if (samples.every(s => s.ctsOffset === 0)) return null;
      const runs = [];
      for (const s of samples) {
        if (runs.length > 0 && runs[runs.length - 1].offset === s.ctsOffset) {
          runs[runs.length - 1].count++;
        } else {
          runs.push({ count: 1, offset: s.ctsOffset });
        }
      }
      const data = new Uint8Array(4 + 4 + runs.length * 8);
      writeU32(data, 4, runs.length);
      for (let i = 0; i < runs.length; i++) {
        writeU32(data, 8 + i * 8, runs[i].count);
        writeU32(data, 12 + i * 8, runs[i].offset);
      }
      return makeBox('ctts', data);
    }

    // ---- Extract existing boxes from the combined moov ----
    function extractBox(parent, type, startOff, maxOff) {
      const box = findBox(parent, type, startOff || 0, maxOff || parent.length);
      return box ? parent.slice(box.offset, box.offset + box.size) : null;
    }

    const existingMvhd = extractBox(combinedMoov, 'mvhd', 8);

    // Find both traks in combinedMoov
    const traks = [];
    let tp = 8;
    while (tp + 8 <= combinedMoov.length) {
      const sz = readU32(combinedMoov, tp);
      if (sz < 8) break;
      if (btype(combinedMoov, tp + 4) === 'trak') {
        traks.push(combinedMoov.slice(tp, tp + sz));
      }
      tp += sz;
    }

    function extractFromTrak(trak) {
      const tkhd = extractBox(trak, 'tkhd', 8);
      const mdiaBox = findBox(trak, 'mdia', 8);
      const mdia = mdiaBox ? trak.slice(mdiaBox.offset, mdiaBox.offset + mdiaBox.size) : null;
      let mdhd = null, hdlr = null, stsd = null, isVideo = false;
      if (mdia) {
        mdhd = extractBox(mdia, 'mdhd', 8);
        hdlr = extractBox(mdia, 'hdlr', 8);
        if (hdlr) {
          // hdlr: fullbox(12) + pre_defined(4) + handler_type(4 bytes at offset 16)
          isVideo = btype(hdlr, 16) === 'vide';
        }
        const minfBox = findBox(mdia, 'minf', 8);
        if (minfBox) {
          const minf = mdia.slice(minfBox.offset, minfBox.offset + minfBox.size);
          const stblBox = findBox(minf, 'stbl', 8);
          if (stblBox) {
            const stbl = minf.slice(stblBox.offset, stblBox.offset + stblBox.size);
            stsd = extractBox(stbl, 'stsd', 8);
          }
          // Extract vmhd or smhd
          const vmhd = extractBox(minf, 'vmhd', 8);
          const smhd = extractBox(minf, 'smhd', 8);
          return { tkhd, mdhd, hdlr, stsd, isVideo, xmhd: vmhd || smhd };
        }
      }
      return { tkhd, mdhd, hdlr, stsd, isVideo, xmhd: null };
    }

    const vTrakInfo = extractFromTrak(traks[0]);
    const aTrakInfo = extractFromTrak(traks[1]);

    // ---- Build new trak for each track ----
    function buildTrak(info, samples, sampleCount) {
      const stts = buildStts(samples);
      const stsz = buildStsz(samples);
      const stss = info.isVideo ? buildStss(samples) : null;
      const ctts = buildCtts(samples);

      // stsc: patch samples_per_chunk
      const stsc = buildStsc();
      // samples_per_chunk is at: box_header(8) + fullbox(4) + entry_count(4) + first_chunk(4) = offset 20
      writeU32(stsc, 20, sampleCount);

      const stco = buildStco(); // placeholder offset, patched later

      // dinf > dref > url
      const urlBox = makeFullBox('url ', 0, 1, new Uint8Array(0)); // flag 1 = self-contained
      const drefData = new Uint8Array(4 + 4);
      writeU32(drefData, 4, 1); // entry_count
      const dref = makeBox('dref', drefData, urlBox);
      const dinf = makeBox('dinf', dref);

      const stblParts = [info.stsd, stts, stsc, stsz, stco];
      if (stss) stblParts.push(stss);
      if (ctts) stblParts.push(ctts);
      const stbl = makeBox('stbl', ...stblParts);

      const minf = makeBox('minf', info.xmhd, dinf, stbl);
      const mdia = makeBox('mdia', info.mdhd, info.hdlr, minf);
      const trak = makeBox('trak', info.tkhd, mdia);
      return trak;
    }

    const newVTrak = buildTrak(vTrakInfo, vSamples, vSamples.length);
    const newATrak = buildTrak(aTrakInfo, aSamples, aSamples.length);

    // Patch durations in mvhd, tkhd, mdhd
    // Get timescale from mdhd of each track
    function getMdhdTimescale(mdhd) {
      const v = mdhd[8];
      return readU32(mdhd, v === 1 ? 28 : 20);
    }
    const vTimescale = getMdhdTimescale(vTrakInfo.mdhd);
    const aTimescale = getMdhdTimescale(aTrakInfo.mdhd);
    const vTotalDur = vSamples.reduce((s, x) => s + x.duration, 0);
    const aTotalDur = aSamples.reduce((s, x) => s + x.duration, 0);

    // Patch mdhd duration in each new trak
    function patchMdhdDuration(trak, duration) {
      // Find mdia > mdhd
      const mdiaBox = findBox(trak, 'mdia', 8);
      if (!mdiaBox) return;
      const mdhdBox = findBox(trak, 'mdhd', mdiaBox.offset + 8, mdiaBox.offset + mdiaBox.size);
      if (!mdhdBox) return;
      const v = trak[mdhdBox.offset + 8];
      writeU32(trak, mdhdBox.offset + (v === 1 ? 32 : 24), duration);
    }

    function patchTkhdDuration(trak, movieDuration) {
      const tkhdBox = findBox(trak, 'tkhd', 8);
      if (!tkhdBox) return;
      const v = trak[tkhdBox.offset + 8];
      writeU32(trak, tkhdBox.offset + (v === 1 ? 36 : 28), movieDuration);
    }

    patchMdhdDuration(newVTrak, vTotalDur);
    patchMdhdDuration(newATrak, aTotalDur);

    // Patch mvhd and tkhd durations (in movie timescale)
    const mvhdV = existingMvhd[8];
    const movieTimescale = readU32(existingMvhd, mvhdV === 1 ? 28 : 20);
    const vMovieDur = Math.round(vTotalDur * movieTimescale / vTimescale);
    const aMovieDur = Math.round(aTotalDur * movieTimescale / aTimescale);
    const maxMovieDur = Math.max(vMovieDur, aMovieDur);
    writeU32(existingMvhd, mvhdV === 1 ? 32 : 24, maxMovieDur);
    patchTkhdDuration(newVTrak, vMovieDur);
    patchTkhdDuration(newATrak, aMovieDur);

    // Build new moov (NO mvex — this is a flat MP4)
    const newMoov = makeBox('moov', existingMvhd, newVTrak, newATrak);

    // ---- Assemble: ftyp + moov + mdat ----
    const vFtypBox = findBox(videoUint8, 'ftyp');
    const ftyp = vFtypBox ? videoUint8.slice(vFtypBox.offset, vFtypBox.offset + vFtypBox.size) : new Uint8Array(0);

    const mdatPayload = cat(vData, aData);
    const mdatBox = new Uint8Array(8 + mdatPayload.length);
    writeU32(mdatBox, 0, mdatBox.length);
    mdatBox[4]=0x6D; mdatBox[5]=0x64; mdatBox[6]=0x61; mdatBox[7]=0x74; // 'mdat'
    mdatBox.set(mdatPayload, 8);

    // ---- Patch stco offsets now that we know moov size ----
    const videoDataOffset = ftyp.length + newMoov.length + 8; // +8 for mdat header
    const audioDataOffset = videoDataOffset + vData.length;

    // Find stco in each trak within newMoov and patch
    function patchStcoInMoov(moov, trakIndex, offset) {
      let trakCount = 0;
      let p = 8;
      while (p + 8 <= moov.length) {
        const sz = readU32(moov, p);
        if (sz < 8) break;
        if (btype(moov, p + 4) === 'trak') {
          if (trakCount === trakIndex) {
            // Deep search for stco inside this trak
            const stcoBox = (function findDeep(buf, type, start, end) {
              let pos = start;
              while (pos + 8 <= end) {
                const s = readU32(buf, pos);
                if (s < 8) break;
                if (btype(buf, pos + 4) === type) return pos;
                // Search inside container boxes
                const inner = findDeep(buf, type, pos + 8, pos + s);
                if (inner !== -1) return inner;
                pos += s;
              }
              return -1;
            })(moov, 'stco', p + 8, p + sz);
            if (stcoBox !== -1) {
              // stco: header(8) + fullbox(4) + entry_count(4) + offsets...
              writeU32(moov, stcoBox + 16, offset);
            }
            return;
          }
          trakCount++;
        }
        p += sz;
      }
    }

    patchStcoInMoov(newMoov, 0, videoDataOffset);
    patchStcoInMoov(newMoov, 1, audioDataOffset);

    return cat(ftyp, newMoov, mdatBox);
  }

  async function triggerBrowserVideoDownload(format, filename, onProgress, signal) {
    onProgress(0, 1, 'Fetching manifest...');
    const resp = await fetch(videoManifestUrl, { signal });
    if (!resp.ok) throw new Error(`Manifest fetch failed: HTTP ${resp.status}`);
    const xmlText = await resp.text();

    onProgress(0, 1, 'Parsing manifest...');
    const allTracks = parseDashManifest(xmlText, videoManifestUrl);
    if (!allTracks.length) throw new Error('No tracks found in manifest');

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

  // ============================================================================
  // Video Download Button & ffmpeg Modal
  // ============================================================================

  function injectVideoDownloadButton() {
    // Check if already injected
    if (document.querySelector('#customDownloadVideo')) return true;

    // Place in the top command bar (alongside Upload, Favorites, etc.)
    // rather than inside the transcript panel
    const commandBar = document.querySelector('.ms-CommandBar-primaryCommand');
    if (!commandBar) {
      console.debug('[Transcript Downloader] Command bar not found yet for video button');
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
    btn.innerHTML = '<span>Download Video</span>';
    btn.addEventListener('click', handleVideoDownloadClick);

    newContainer.appendChild(btn);
    commandBar.appendChild(newContainer);

    console.debug('[Transcript Downloader] Video download button injected into command bar');
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

  function buildDownloadCommand(manifestUrl, filename, format, tool) {
    const safeFilename = filename.replace(/[^a-z0-9_\s-]/gi, '_');

    const ffmpegCommands = {
      'video-audio': { flags: '-map 0:v:0 -map 0:a:0 -c copy', ext: '.mp4' },
      'audio-m4a':   { flags: '-map 0:a:0 -vn -c:a copy',      ext: '.m4a' },
      'audio-mp3':   { flags: '-map 0:a:0 -vn',                 ext: '.mp3' },
      'audio-wav':   { flags: '-map 0:a:0 -vn',                 ext: '.wav' },
      'video-only':  { flags: '-map 0:v:0 -an -c:v copy',       ext: '.mp4' }
    };

    if (tool === 'yt-dlp') {
      // yt-dlp with parallel fragment downloading (-N 16)
      const ytdlpFormats = {
        'video-audio': { flags: '-N 16',                                    ext: '.mp4' },
        'audio-m4a':   { flags: '-N 16 -x --audio-format m4a',             ext: '.m4a' },
        'audio-mp3':   { flags: '-N 16 -x --audio-format mp3',             ext: '.mp3' },
        'audio-wav':   { flags: '-N 16 -x --audio-format wav',             ext: '.wav' },
        'video-only':  { flags: '-N 16 --no-audio',                        ext: '.mp4' }
      };
      const config = ytdlpFormats[format];
      if (!config) return '';
      return `yt-dlp ${config.flags} -o "${safeFilename}${config.ext}" "${manifestUrl}"`;
    }

    // Default: ffmpeg
    const config = ffmpegCommands[format];
    if (!config) return '';
    return `ffmpeg -i "${manifestUrl}" ${config.flags} "${safeFilename}${config.ext}"`;
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

    const cliFormats = [
      { id: 'video-audio', title: 'Video + Audio', badge: '.mp4', icon: '&#127916;' },
      { id: 'audio-m4a', title: 'Audio (M4A)', badge: '.m4a', icon: '&#127925;' },
      { id: 'audio-mp3', title: 'Audio (MP3)', badge: '.mp3', icon: '&#127925;' },
      { id: 'audio-wav', title: 'Audio (WAV)', badge: '.wav', icon: '&#127925;' },
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

        <div class="video-tab-bar">
          <button class="video-tab-btn active" data-tab="download">Download <span class="video-tab-hint">in browser</span></button>
          <button class="video-tab-btn" data-tab="ffmpeg">ffmpeg <span class="video-tab-hint">CLI</span></button>
          <button class="video-tab-btn" data-tab="yt-dlp">yt-dlp <span class="video-tab-hint">CLI</span></button>
        </div>

        <!-- Download Tab -->
        <div class="video-tab-panel active" data-panel="download">
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
        </div>

        <!-- ffmpeg Tab -->
        <div class="video-tab-panel" data-panel="ffmpeg">
          <div class="video-info-warning">
            Copy the command below and run it in your terminal. The URL contains a temporary auth token that will expire.
          </div>
          <div class="video-format-cards">
            ${renderCards(cliFormats, 'ffmpeg')}
          </div>
          <div class="ffmpeg-command-section" id="ffmpegCommandSection" style="display: none;">
            <label class="filename-label"><span class="label-text">Command:</span></label>
            <div class="ffmpeg-command" id="ffmpegCommandText"></div>
            <button class="ffmpeg-copy-btn" id="ffmpegCopyBtn">Copy Command</button>
          </div>
        </div>

        <!-- yt-dlp Tab -->
        <div class="video-tab-panel" data-panel="yt-dlp">
          <div class="video-info-warning">
            Copy the command below and run it in your terminal. The URL contains a temporary auth token that will expire.
          </div>
          <div class="video-format-cards">
            ${renderCards(cliFormats, 'ytdlp')}
          </div>
          <div class="ffmpeg-command-section" id="ytdlpCommandSection" style="display: none;">
            <label class="filename-label"><span class="label-text">Command:</span></label>
            <div class="ffmpeg-command" id="ytdlpCommandText"></div>
            <button class="ffmpeg-copy-btn" id="ytdlpCopyBtn">Copy Command</button>
          </div>
        </div>

        <div class="modal-actions">
          <button class="modal-button modal-button-cancel" id="videoModalCancel">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let abortController = null;

    // Tab switching
    const tabBtns = modal.querySelectorAll('.video-tab-btn');
    const tabPanels = modal.querySelectorAll('.video-tab-panel');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        modal.querySelector(`[data-panel="${btn.getAttribute('data-tab')}"]`).classList.add('active');
      });
    });

    // --- Download tab logic ---
    const dlCards = modal.querySelectorAll('[data-panel="download"] .video-format-card');
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
        } else {
          console.error('[Transcript Downloader] Browser download error:', err);
          status.textContent = 'Error: ' + err.message;
          bar.classList.add('browser-dl-error');
        }
      } finally {
        abortController = null;
        dlBtn.textContent = '\u2193 Download';
        dlBtn.classList.remove('browser-dl-cancelling');
        dlCards.forEach(c => { c.style.pointerEvents = ''; c.style.opacity = ''; });
      }
    });

    // --- ffmpeg tab logic ---
    const ffmpegCards = modal.querySelectorAll('[data-panel="ffmpeg"] .video-format-card');
    let selectedFfmpegFormat = null;

    function updateFfmpegCommand() {
      if (!selectedFfmpegFormat) return;
      const filename = modal.querySelector('#videoFilenameInput').value.trim() || 'video';
      const cmd = buildDownloadCommand(videoManifestUrl, filename, selectedFfmpegFormat, 'ffmpeg');
      const section = modal.querySelector('#ffmpegCommandSection');
      const text = modal.querySelector('#ffmpegCommandText');
      text.textContent = cmd;
      section.style.display = 'block';
      modal.querySelector('#ffmpegCopyBtn').textContent = 'Copy Command';
    }

    ffmpegCards.forEach(card => {
      card.addEventListener('click', () => {
        ffmpegCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedFfmpegFormat = card.getAttribute('data-format');
        updateFfmpegCommand();
      });
    });

    modal.querySelector('#ffmpegCopyBtn').addEventListener('click', () => {
      const text = modal.querySelector('#ffmpegCommandText').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = modal.querySelector('#ffmpegCopyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Command'; }, 2000);
      }).catch(() => {
        const range = document.createRange();
        range.selectNodeContents(modal.querySelector('#ffmpegCommandText'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });

    // --- yt-dlp tab logic ---
    const ytdlpCards = modal.querySelectorAll('[data-panel="yt-dlp"] .video-format-card');
    let selectedYtdlpFormat = null;

    function updateYtdlpCommand() {
      if (!selectedYtdlpFormat) return;
      const filename = modal.querySelector('#videoFilenameInput').value.trim() || 'video';
      const cmd = buildDownloadCommand(videoManifestUrl, filename, selectedYtdlpFormat, 'yt-dlp');
      const section = modal.querySelector('#ytdlpCommandSection');
      const text = modal.querySelector('#ytdlpCommandText');
      text.textContent = cmd;
      section.style.display = 'block';
      modal.querySelector('#ytdlpCopyBtn').textContent = 'Copy Command';
    }

    ytdlpCards.forEach(card => {
      card.addEventListener('click', () => {
        ytdlpCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedYtdlpFormat = card.getAttribute('data-format');
        updateYtdlpCommand();
      });
    });

    modal.querySelector('#ytdlpCopyBtn').addEventListener('click', () => {
      const text = modal.querySelector('#ytdlpCommandText').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = modal.querySelector('#ytdlpCopyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Command'; }, 2000);
      }).catch(() => {
        const range = document.createRange();
        range.selectNodeContents(modal.querySelector('#ytdlpCommandText'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });

    // Filename input updates commands live
    modal.querySelector('#videoFilenameInput').addEventListener('input', () => {
      updateFfmpegCommand();
      updateYtdlpCommand();
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
  function initialize() {
    let transcriptDone = injectDownloadButton();
    let videoDone = injectVideoDownloadButton();

    if (transcriptDone && videoDone) {
      console.debug('[Transcript Downloader] Both buttons injected on initial load');
      return;
    }

    // Watch for DOM changes until both buttons are injected
    const observer = new MutationObserver((mutations) => {
      if (!transcriptDone) transcriptDone = injectDownloadButton();
      if (!videoDone) videoDone = injectVideoDownloadButton();

      if (transcriptDone && videoDone) {
        console.debug('[Transcript Downloader] Both buttons injected after DOM change');
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      observer.disconnect();
      console.debug('[Transcript Downloader] Stopped observing after timeout');
    }, 30000);
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