// Content script that runs on MS Teams/SharePoint pages
// Injects a custom download button next to the disabled download transcript button

(function() {
  'use strict';

  console.log('[MS Teams Transcript Downloader] Content script loaded');

  let transcriptUrl = null;
  let transcriptData = null; // Will store the JSON data
  let vttData = null; // Will store converted VTT
  let selectedFormat = 'vtt'; // Default format (json, vtt, or vtt-grouped)

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
    
    // Generate JSON preview (first 500 chars)
    const jsonPreview = transcriptData ? JSON.stringify(JSON.parse(transcriptData), null, 2).substring(0, 500) + '...' : 'Loading preview...';
    
    // Generate preview for VTT (first 500 chars)
    const vttPreview = vttData ? vttData.substring(0, 500) + '...' : 'Loading preview...';
    
    // Generate preview for grouped format
    let groupedPreview = 'Loading preview...';
    if (transcriptData) {
      const grouped = convertJSONToGrouped(transcriptData);
      groupedPreview = grouped.substring(0, 500) + '...';
    }
    
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
      });
    });
    
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
      modal.classList.remove('show');
      proceedWithDownload();
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
      labelSpan.textContent = 'Download';
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
  function proceedWithDownload() {
    if (!transcriptData) {
      alert('No transcript data available');
      return;
    }

    let outputData = transcriptData; // JSON by default
    let extension = '.json';
    
    // Convert based on selected format
    if (selectedFormat === 'vtt') {
      outputData = vttData;
      extension = '.vtt';
    } else if (selectedFormat === 'vtt-grouped') {
      // Convert JSON to grouped format
      outputData = convertJSONToGrouped(transcriptData);
      extension = '_grouped.txt';
    }

    // Get window title for filename
    const pageTitle = document.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${pageTitle}_transcript${extension}`;

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

  // Monitor for transcript page and inject button
  function initialize() {
    // Try to inject immediately
    if (injectDownloadButton()) {
      console.debug('[Transcript Downloader] Button injected on initial load');
      return;
    }

    // If not found, set up a MutationObserver to watch for the button to appear
    const observer = new MutationObserver((mutations) => {
      if (injectDownloadButton()) {
        console.debug('[Transcript Downloader] Button injected after DOM change');
        observer.disconnect();
      }
    });

    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Stop observing after 30 seconds to prevent resource waste
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
