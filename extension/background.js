// background.js — opens the portal tab, holds the credentials for it briefly,
// and injects the autofill script into that one tab.
//
// Deliberately different from a simpler design where autofill is declared as a
// content script on <all_urls>: that runs the filler on every page you visit for
// the rest of the session. Here nothing is injected until you actually press
// Launch and fill, and only into the tab that was opened for it.

const TTL_MS = 5 * 60 * 1000;   // how long credentials stay available
const log = (...a) => console.log('[BCL bg]', ...a);

const credKey = (tabId) => `creds_${tabId}`;

async function injectAutofill(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['autofill.js']
    });
  } catch (e) {
    // A portal page can refuse injection (chrome:// pages, PDF viewer, some
    // redirects). Nothing to recover — log it so the reason is visible.
    log('inject failed on tab', tabId, '-', e.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'BCL_LAUNCH') {
    (async () => {
      try {
        // Open blank first, stash the credentials against the new tab id, and
        // only then navigate. Doing it the other way round races the page load.
        const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        await chrome.storage.session.set({
          [credKey(tab.id)]: {
            username: msg.username || '',
            password: msg.password || '',
            ts: Date.now()
          }
        });
        await chrome.tabs.update(tab.id, { url: msg.url });
        log('launched tab', tab.id, 'for', msg.url);

        setTimeout(() => chrome.storage.session.remove(credKey(tab.id)).catch(() => {}), TTL_MS);
        sendResponse({ ok: true, tabId: tab.id });
      } catch (e) {
        console.error('[BCL bg] launch error', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'BCL_REQUEST_CREDS' && sender.tab?.id != null) {
    chrome.storage.session.get(credKey(sender.tab.id))
      .then(r => sendResponse(r?.[credKey(sender.tab.id)] || null));
    return true;
  }

  if (msg?.type === 'BCL_CLEAR_CREDS' && sender.tab?.id != null) {
    chrome.storage.session.remove(credKey(sender.tab.id)).then(() => sendResponse(true));
    return true;
  }
});

// Inject on each completed load of a tab we have credentials for. Covers the
// first load and any redirect the portal does on the way to its login page.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const r = await chrome.storage.session.get(credKey(tabId));
  const creds = r?.[credKey(tabId)];
  if (!creds) return;
  if (Date.now() - creds.ts > TTL_MS) {
    await chrome.storage.session.remove(credKey(tabId));
    return;
  }
  injectAutofill(tabId);
});

// Don't leave credentials behind for a tab that no longer exists.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(credKey(tabId)).catch(() => {});
});
