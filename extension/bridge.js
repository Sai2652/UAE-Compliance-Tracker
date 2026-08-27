// bridge.js — runs in the ISOLATED content-script world at document_start.
//
// Listens for launch requests from the tracker page and forwards them to the
// service worker, which is the only place that can call chrome.tabs.
//
// Same marker rule as bridge-main.js: the attribute has to be in the page's
// static markup, because this runs before the page's own scripts do.

(function () {
  if (!document.documentElement.hasAttribute('data-bcl-tracker')) return;

  window.addEventListener('message', (ev) => {
    // Only messages this page posted to itself. Never act on a message from a
    // frame or another window — the payload carries credentials.
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;

    const m = ev.data;
    if (!m || m.source !== 'bcl-compliance-tracker' || m.type !== 'BCL_LAUNCH') return;

    const { url, username, password } = m.payload || {};
    if (!url) return;

    try {
      chrome.runtime.sendMessage({ type: 'BCL_LAUNCH', url, username, password }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[BCL bridge] sendMessage error:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.error('[BCL bridge] sendMessage threw', e);
    }
  });
})();
