// autofill.js — injected by background.js into a tab opened by "Launch & fill".
// Finds the login form, fills it, and stops. It never presses Login: UAE portals
// put a captcha or security code next to the password, so submitting is yours.
//
// The waiting matters more than the filling. EmaraTax opens on a UAE PASS screen
// with no email or password field at all — they only mount when the user clicks
// "Login here", and the address bar never changes, so there is no navigation to
// hook. We poll and watch the DOM until the fields appear.

(function () {
  // background.js re-injects on every completed load; only set up once per frame.
  if (window.__BCL_AUTOFILL_ACTIVE__) return;
  window.__BCL_AUTOFILL_ACTIVE__ = true;

  // Never run on the tracker itself.
  if (document.documentElement.hasAttribute('data-bcl-tracker')) return;

  const log = (...a) => console.log('[BCL autofill]', ...a);
  log('watching', location.href);

  const WATCH_MS = 5 * 60 * 1000;
  const startedAt = Date.now();
  let filled = false, creds = null, userField = null, pwdField = null;

  function getCreds() {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'BCL_REQUEST_CREDS' }, (r) => {
          if (chrome.runtime.lastError) { res(null); return; }
          res(r || null);
        });
      } catch (e) { res(null); }
    });
  }

  function visible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findPassword() {
    return Array.from(document.querySelectorAll('input[type="password"]')).find(visible) || null;
  }

  // The username is the last visible text-ish input that sits BEFORE the password
  // in document order. On EmaraTax that correctly picks the E-mail box and skips
  // the "Enter security code" field, which sits after the password.
  function findUsernameFor(pwd) {
    const all = Array.from(document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
    )).filter(visible);
    const scoped = pwd.form ? all.filter(i => i.form === pwd.form) : all;
    const candidates = scoped.length ? scoped : all;
    let chosen = null;
    for (const inp of candidates) {
      if (inp.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING) chosen = inp;
    }
    return chosen || candidates[0] || null;
  }

  // Assigning .value directly is invisible to React/Angular/UI5, which track
  // their own state. Go through the native setter and fire the events they watch.
  function setValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    ['input', 'change'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function flash(el) {
    if (!el) return;
    const prev = el.style.boxShadow;
    el.style.transition = 'box-shadow .2s';
    el.style.boxShadow = '0 0 0 3px rgba(20,98,92,.45)';
    setTimeout(() => { el.style.boxShadow = prev; }, 1400);
  }

  function banner(text) {
    const id = '__bcl_banner__';
    let d = document.getElementById(id);
    if (d) { d.textContent = text; return; }
    d = document.createElement('div');
    d.id = id; d.textContent = text; d.title = 'Click to dismiss';
    Object.assign(d.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: 2147483647,
      background: '#14625C', color: '#fff', padding: '10px 14px', borderRadius: '10px',
      font: '600 13px/1.35 -apple-system,Segoe UI,Roboto,sans-serif',
      boxShadow: '0 10px 30px rgba(15,23,42,.3)', maxWidth: '320px', cursor: 'pointer'
    });
    d.addEventListener('click', () => d.remove());
    (document.body || document.documentElement).appendChild(d);
    setTimeout(() => d.remove(), 8000);
  }

  function reapply() {
    if (!creds) return false;
    let any = false;
    if (userField && creds.username && userField.value !== creds.username) { setValue(userField, creds.username); any = true; }
    if (pwdField && creds.password && pwdField.value !== creds.password) { setValue(pwdField, creds.password); any = true; }
    return any;
  }

  function fill(c) {
    const pwd = findPassword();
    if (!pwd) return false;
    creds = c; pwdField = pwd; userField = c.username ? findUsernameFor(pwd) : null;

    if (userField && c.username) { setValue(userField, c.username); flash(userField); }
    if (c.password) { setValue(pwd, c.password); flash(pwd); }
    filled = true;
    log('filled', { username: c.username, passwordChars: (c.password || '').length });
    banner('Filled ' + (c.username || 'credentials') + ' — check them, then log in.');

    // The browser's own password manager often overwrites us a moment later.
    // Re-assert for a few seconds, and whenever the fields are touched.
    let kicks = 0;
    const iv = setInterval(() => { if (reapply()) flash(pwdField); if (++kicks >= 50) clearInterval(iv); }, 100);
    [userField, pwd].forEach(f => {
      if (!f) return;
      ['change', 'blur', 'focus'].forEach(t => f.addEventListener(t, reapply, true));
    });

    // Don't leave them sitting in session storage once they're on the page.
    try { chrome.runtime.sendMessage({ type: 'BCL_CLEAR_CREDS' }); } catch (e) {}
    return true;
  }

  let attempts = 0;
  async function tick() {
    if (filled) return;
    if (Date.now() - startedAt > WATCH_MS) { log('gave up after 5 minutes'); return; }
    attempts++;
    const c = await getCreds();
    if (c && (c.username || c.password)) {
      if (fill(c)) { log('done after', attempts, 'attempts'); return; }
      if (attempts % 12 === 0) log('no password field yet — still waiting (click through to the login form)');
    }
    setTimeout(tick, attempts < 20 ? 250 : attempts < 60 ? 500 : 1500);
  }
  tick();

  // The form usually mounts without a navigation, so watch for it directly.
  try {
    new MutationObserver(() => { if (!filled) tick(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
