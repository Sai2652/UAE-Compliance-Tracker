// bridge-main.js — runs in the page's MAIN world, at document_start.
//
// Its only job is to tell the tracker page that this extension is installed, so
// the page can say "install the companion extension" instead of opening a portal
// and mysteriously failing to fill it.
//
// The guard reads data-bcl-tracker off the root element. That attribute MUST be
// in the tracker's static markup — this script runs before any of the page's own
// scripts, so an attribute set from page JavaScript does not exist yet.

(function () {
  if (!document.documentElement.hasAttribute('data-bcl-tracker')) return;
  window.__BCL_TRACKER_EXT__ = true;
  try { window.dispatchEvent(new Event('BCL_TRACKER_EXT_READY')); } catch (e) {}
})();
