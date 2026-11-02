// Content scripts for sites the user enables from the toolbar popup.
//
// The manifest's content_scripts cover the Microsoft hosts the extension
// supports out of the box. Other sites, such as a SharePoint tenant served
// from the organisation's own domain, are opt-in: the popup asks for host
// access to one origin at a time (optional_host_permissions), and this worker
// keeps a dynamic registration of the same two scripts in step with the
// origins the user has granted. Removing the site's access in
// chrome://extensions removes the registration as well.

const USER_SITE_SCRIPT_IDS = ['ttd-intercept-user-sites', 'ttd-content-user-sites'];

// Origins granted through optional_host_permissions. permissions.getAll()
// also lists the manifest's host_permissions, which the static
// content_scripts already cover.
async function grantedUserOrigins() {
  const builtIn = new Set(chrome.runtime.getManifest().host_permissions || []);
  const { origins = [] } = await chrome.permissions.getAll();
  return origins.filter((origin) => !builtIn.has(origin));
}

async function syncUserSiteScripts() {
  const matches = await grantedUserOrigins();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: USER_SITE_SCRIPT_IDS });
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
  }
  if (!matches.length) return;
  // Same files, worlds and timing as the manifest's content_scripts entries.
  await chrome.scripting.registerContentScripts([
    {
      id: USER_SITE_SCRIPT_IDS[0],
      matches,
      js: ['intercept.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN'
    },
    {
      id: USER_SITE_SCRIPT_IDS[1],
      matches,
      js: ['content.js'],
      css: ['modal.css'],
      runAt: 'document_idle',
      allFrames: true
    }
  ]);
}

// Events can arrive together (an install while a grant is pending), and an
// unregister/register pair must not interleave with another one.
let syncQueue = Promise.resolve();
function queueSync() {
  syncQueue = syncQueue
    .then(syncUserSiteScripts)
    .catch((err) => console.error('[Transcript Downloader] Could not update the scripts for enabled sites:', err));
  return syncQueue;
}

chrome.runtime.onInstalled.addListener(() => { queueSync(); });

chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await queueSync();
  if (!origins.length) return;
  // Reload the tab the site was enabled from so the scripts run from
  // document_start; the fetch hook in intercept.js has to be in place before
  // the player's first request. Other open tabs on the site are left alone.
  const tabs = await chrome.tabs.query({ url: origins, active: true, lastFocusedWindow: true });
  for (const tab of tabs) chrome.tabs.reload(tab.id);
});

chrome.permissions.onRemoved.addListener(() => { queueSync(); });

// "Disable on this site" from the popup. The registration is removed before
// the tab reloads; reloading straight after permissions.remove() can still
// inject the scripts into the new page while the removal is propagating.
async function disableSite(origins, tabId) {
  await chrome.permissions.remove({ origins });
  await queueSync();
  if (Number.isInteger(tabId)) await chrome.tabs.reload(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the popup sends this; content scripts run in tabs.
  if (sender.id !== chrome.runtime.id || sender.tab || !message || message.type !== 'ttd-disable-site') return false;
  disableSite(message.origins, message.tabId).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
  );
  return true;
});
