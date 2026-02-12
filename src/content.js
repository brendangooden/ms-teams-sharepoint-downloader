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

    const formats = [
      { id: 'video-audio', title: 'Video + Audio', badge: '.mp4', icon: '&#127916;' },
      { id: 'audio-m4a', title: 'Audio (M4A)', badge: '.m4a', icon: '&#127925;' },
      { id: 'audio-mp3', title: 'Audio (MP3)', badge: '.mp3', icon: '&#127925;' },
      { id: 'audio-wav', title: 'Audio (WAV)', badge: '.wav', icon: '&#127925;' },
      { id: 'video-only', title: 'Video Only', badge: '.mp4', icon: '&#127910;' }
    ];

    const formatCardsHtml = formats.map(f => `
      <div class="video-format-card" data-format="${f.id}">
        <div class="video-format-icon">${f.icon}</div>
        <div class="video-format-info">
          <h3>${f.title} <span class="format-badge video-badge">${f.badge}</span></h3>
        </div>
      </div>
    `).join('');

    modal.innerHTML = `
      <div class="modal-content video-modal-content">
        <div class="modal-header">
          <h2>Download Video</h2>
          <button class="modal-close" id="videoModalClose">&times;</button>
        </div>

        <div class="video-info-warning">
          <strong>Requires ffmpeg or yt-dlp</strong> — SharePoint blocks direct video downloads.
          Select a format below, then copy and run the command in your terminal.
          The URL contains a temporary auth token that will expire.
        </div>

        <div class="video-tool-toggle">
          <button class="tool-toggle-btn active" data-tool="ffmpeg">ffmpeg <span class="tool-hint">simple</span></button>
          <button class="tool-toggle-btn" data-tool="yt-dlp">yt-dlp <span class="tool-hint">parallel &amp; faster</span></button>
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
          ${formatCardsHtml}
        </div>

        <div class="ffmpeg-command-section" id="ffmpegCommandSection" style="display: none;">
          <label class="filename-label"><span class="label-text">Command:</span></label>
          <div class="ffmpeg-command" id="ffmpegCommandText"></div>
          <button class="ffmpeg-copy-btn" id="ffmpegCopyBtn">Copy Command</button>
        </div>

        <div class="modal-actions">
          <button class="modal-button modal-button-cancel" id="videoModalCancel">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let selectedVideoFormat = null;
    let selectedTool = 'ffmpeg';

    function updateCommand() {
      if (!selectedVideoFormat) return;
      const filename = modal.querySelector('#videoFilenameInput').value.trim() || 'video';
      const cmd = buildDownloadCommand(videoManifestUrl, filename, selectedVideoFormat, selectedTool);
      const commandSection = modal.querySelector('#ffmpegCommandSection');
      const commandText = modal.querySelector('#ffmpegCommandText');
      commandText.textContent = cmd;
      commandSection.style.display = 'block';
      const copyBtn = modal.querySelector('#ffmpegCopyBtn');
      copyBtn.textContent = 'Copy Command';
    }

    // Tool toggle
    const toolBtns = modal.querySelectorAll('.tool-toggle-btn');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toolBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedTool = btn.getAttribute('data-tool');
        updateCommand();
      });
    });

    // Format card selection
    const cards = modal.querySelectorAll('.video-format-card');
    cards.forEach(card => {
      card.addEventListener('click', () => {
        cards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedVideoFormat = card.getAttribute('data-format');
        updateCommand();
      });
    });

    // Filename input updates command live
    modal.querySelector('#videoFilenameInput').addEventListener('input', updateCommand);

    // Copy button
    modal.querySelector('#ffmpegCopyBtn').addEventListener('click', () => {
      const commandText = modal.querySelector('#ffmpegCommandText').textContent;
      navigator.clipboard.writeText(commandText).then(() => {
        const copyBtn = modal.querySelector('#ffmpegCopyBtn');
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Command'; }, 2000);
      }).catch(err => {
        console.error('[Transcript Downloader] Failed to copy:', err);
        const range = document.createRange();
        range.selectNodeContents(modal.querySelector('#ffmpegCommandText'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });

    // Close handlers
    modal.querySelector('#videoModalClose').addEventListener('click', () => {
      modal.classList.remove('show');
    });

    modal.querySelector('#videoModalCancel').addEventListener('click', () => {
      modal.classList.remove('show');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('show');
      }
    });
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
