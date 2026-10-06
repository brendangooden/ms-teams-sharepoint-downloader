// Toolbar popup: read the version from the manifest so it never goes stale
// (MV3 extension pages can't run inline scripts, hence this file)
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
