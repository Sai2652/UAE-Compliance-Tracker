// The entity-type catalogue exists twice: entityTypes.js for the server (the
// Ops-Mkt sync runs on a cron with no browser) and app.html for the UI (it is
// served as a static file and cannot require a module).
//
// Two copies drift. This asserts they have not: same values, same order, same
// groups, same guidance text. Run it before shipping a change to either.
//
//   node scripts/check-entity-types.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = require(path.join(root, 'entityTypes.js'));
const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
}

// Pull the browser catalogue out of the page and evaluate just that literal.
const start = html.indexOf('const ENTITY_TYPE_CATALOGUE=[');
if (start === -1) { fail('ENTITY_TYPE_CATALOGUE not found in app.html'); process.exit(1); }
const open = html.indexOf('[', start);
let depth = 0, end = -1;
for (let i = open; i < html.length; i++) {
  if (html[i] === '[') depth++;
  else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
}
if (end === -1) { fail('could not find the end of the browser catalogue'); process.exit(1); }

let browser;
try {
  browser = eval(html.slice(open, end + 1));
} catch (e) {
  fail('browser catalogue does not parse: ' + e.message);
  process.exit(1);
}

const a = server.ENTITY_TYPE_CATALOGUE;
const b = browser;

if (a.length !== b.length) {
  fail('different lengths — entityTypes.js has ' + a.length + ', app.html has ' + b.length);
} else {
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    ['value', 'group', 'hint'].forEach(function(k) {
      if (a[i][k] !== b[i][k]) {
        fail('entry ' + i + ' field "' + k + '" differs:\n  server:  ' + a[i][k] + '\n  browser: ' + b[i][k]);
        diffs++;
      }
    });
  }
  if (!diffs) console.log('OK — ' + a.length + ' entity types match in entityTypes.js and app.html');
}

// The business-nature list is short but shares the same failure mode.
const nm = html.match(/const BUSINESS_NATURES=(\[[^\]]*\]);/);
if (!nm) fail('BUSINESS_NATURES not found in app.html');
else {
  const bn = eval(nm[1]);
  if (JSON.stringify(bn) !== JSON.stringify(server.BUSINESS_NATURES)) {
    fail('BUSINESS_NATURES differ:\n  server:  ' + JSON.stringify(server.BUSINESS_NATURES) + '\n  browser: ' + JSON.stringify(bn));
  } else {
    console.log('OK — business natures match');
  }
}
