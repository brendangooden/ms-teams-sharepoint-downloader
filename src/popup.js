// Toolbar popup: read the version from the manifest so it never goes stale
// (MV3 extension pages can't run inline scripts, hence this file)
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// True when `url` matches a manifest match pattern of the forms the manifest
// uses: a fixed scheme, a host with an optional leading "*." and any path.
function matchesPattern(url, pattern) {
  const m = /^(https?):\/\/(\*\.)?([^/*]+)\//.exec(pattern);
  if (!m || url.protocol !== m[1] + ':') return false;
  return url.hostname === m[3] || (!!m[2] && url.hostname.endsWith('.' + m[3]));
}

// The extension always runs on the hosts in the manifest's content_scripts.
// Any other https site can be enabled from here: Chrome asks the user to
// allow access to that one origin, and background.js registers the content
// scripts for it once access is granted.
async function initThisSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try {
    url = tab && tab.url ? new URL(tab.url) : null;
  } catch (_) {
    url = null;
  }
  if (!url || url.protocol !== 'https:') return;
  const builtIn = (chrome.runtime.getManifest().content_scripts || []).flatMap((s) => s.matches || []);
  if (builtIn.some((pattern) => matchesPattern(url, pattern))) return;

  const section = document.getElementById('thisSite');
  const text = document.getElementById('thisSiteText');
  const button = document.getElementById('thisSiteButton');
  const host = url.hostname;
  const origins = [url.origin + '/*'];
  const enabled = await chrome.permissions.contains({ origins });

  const strong = document.createElement('strong');
  strong.textContent = host;
  if (enabled) {
    text.replaceChildren('Enabled on ', strong, '.');
    button.textContent = 'Disable on this site';
    button.classList.add('modal-button-cancel');
  } else {
    text.replaceChildren(
      'Videos on another domain? If ', strong,
      ' serves SharePoint or OneDrive videos, the extension can run here too.'
    );
    button.textContent = 'Enable on ' + host;
    button.classList.add('modal-button-download');
  }
  section.hidden = false;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (enabled) {
        const res = await chrome.runtime.sendMessage({ type: 'ttd-disable-site', origins, tabId: tab.id });
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'no response from the extension');
        window.close();
        return;
      }
      // Must be the first call in the click handler: Chrome only shows the
      // access prompt while the click's user gesture is still current.
      if (await chrome.permissions.request({ origins })) {
        // background.js registers the scripts and reloads this tab.
        window.close();
        return;
      }
      text.replaceChildren('Access to ', strong, ' was not granted.');
    } catch (err) {
      text.textContent = 'Could not change site access: ' + (err && err.message ? err.message : err);
    }
    button.disabled = false;
  });
}

initThisSite().catch((err) => console.error('[Transcript Downloader] Popup site check failed:', err));
