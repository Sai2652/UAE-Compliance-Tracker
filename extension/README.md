# BCL Compliance Companion

The browser extension behind **Launch & fill** in the UAE Compliance Tracker.

A web page cannot type into a form on another website — browsers forbid it, and
that rule is what stops any site reading your bank login. So the tracker hands
the job to this extension, which is allowed to.

## Install (one-time, about 30 seconds)

1. Open Chrome or Edge → `chrome://extensions`
2. Turn **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select this `extension` folder
5. Reload the tracker

The tracker tells you if the extension isn't there: Launch & fill still opens the
portal, and says plainly that nothing was filled.

## What it does

1. You press **Launch & fill** next to a saved portal credential
2. The extension opens that portal in a new tab
3. It waits for a login form to appear, then fills the username and password
4. It highlights what it filled and shows a small banner

**It does not press Login.** UAE portals put a captcha or security code next to
the password, so submitting stays with you.

## EmaraTax needs one extra click

`eservices.tax.gov.ae` opens on a screen offering **Sign in with UAE PASS**. That
screen has no email or password field at all — they only appear when you click
**“Login here”** under *“Non UAE PASS users may”*.

The FTA gives that view no address of its own: clicking the link leaves the URL on
`#/Logon`, because it swaps the form in place. So no link can take you straight
there. The extension keeps watching the page for five minutes, so the moment you
click through, the fields fill themselves.

## How credentials are handled

- Held only for the tab that was opened, keyed by that tab's id
- Expire after **5 minutes**, and are dropped as soon as they've been filled in
- Kept in `chrome.storage.session` — gone when the browser closes
- Never sent to any server by this extension

The filler is **injected only into the tab you launched**, when you launch it. It
is not a content script running on every site you browse. Two small scripts do
run everywhere (`bridge.js`, `bridge-main.js`), but each exits immediately unless
the page carries the tracker's `data-bcl-tracker` marker.

Worth being straight about the limit: the credentials still have to reach the
browser in clear text to be typed into a form. That is inherent to autofill, and
it is why the tracker storing portal passwords at all is a decision worth taking
deliberately.

## If it stops working

Open DevTools on the portal tab. You should see `[BCL autofill] watching …`.

- **No such line** → the extension isn't loaded, or the page blocked injection.
  Check `chrome://extensions` and reload the tracker.
- **The line appears but nothing fills** → the form probably hasn't mounted yet.
  On EmaraTax, click “Login here”. The console logs when it's still waiting.
- **Filled the wrong box** → the username is picked as the last visible text
  field before the password. A portal that puts them in an unusual order needs a
  rule in `findUsernameFor()` in `autofill.js`.

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 declaration |
| `bridge-main.js` | MAIN world, sets `window.__BCL_TRACKER_EXT__` so the tracker knows it's installed |
| `bridge.js` | Isolated world, forwards `BCL_LAUNCH` from the page to the service worker |
| `background.js` | Opens the tab, holds credentials for it, injects the filler |
| `autofill.js` | Finds the form and fills it. Injected on demand, never declared globally |
| `popup.html` | Toolbar popup — status and the EmaraTax hint |

Related: the Anyah Client Dashboard has its own separate companion extension.
They are independent, can both be installed, and do not interfere — each only
responds to its own marker and its own message name.
