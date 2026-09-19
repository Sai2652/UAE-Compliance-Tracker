#!/usr/bin/env node
// Build step for the HTML pages (app.html + auth pages). For each file:
//   1) each inline <script> is minified with Terser then obfuscated with
//      javascript-obfuscator (moderate preset — the aggressive ones slow
//      the app noticeably; string encryption + control-flow flattening
//      is the sweet spot for "unreadable at a glance" without a runtime
//      penalty a user would feel).
//   2) each inline <style> is minified with cssnano.
//   3) the whole HTML is collapsed with html-minifier-terser (whitespace,
//      comments) — the script and style blocks are already minified so
//      those minifiers are turned off inside html-minifier.
//
// Output goes to .build/. The Express serve helper in app.js prefers
// .build/<file> when it exists, so local dev (no build) keeps serving
// the readable source and only production runs the obfuscated one.
//
// External <script src="…"> tags are left alone (they're CDN payloads,
// not our code). Skips gracefully on any parse error — the block is
// left as source in the output so the page still boots.

const fs = require('fs');
const path = require('path');
const { minify: minifyJs } = require('terser');
const { minify: minifyHtml } = require('html-minifier-terser');
const cssnano = require('cssnano');
const postcss = require('postcss');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.build');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const FILES = ['app.html', 'login.html', 'signup.html', 'reset-password.html'];

// Obfuscation preset — moderate. Rationale in the code comments below each key.
const OBFUSCATE_OPTS = {
  compact: true,
  // Reorders execution into a switch/dispatcher — the biggest single win
  // for "impossible to skim". 0.5 = half the eligible functions, which is
  // enough to make the code unreadable without slowing it noticeably.
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  // Sprinkles unreachable branches so grepping for a real string turns up
  // decoys. Kept low because it inflates size.
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.15,
  // The single most important protection — string literals get pushed into
  // a lookup table, decoded at runtime. Base64 is fastest; the RC4 option
  // added measurable startup time.
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.7,
  stringArrayCallsTransform: true,
  // Hex identifiers so you can't guess intent from a variable name.
  identifierNamesGenerator: 'hexadecimal',
  // KEEP globals readable — inline scripts share window with the rest of
  // the page. Renaming globals here breaks anything the browser sets
  // (currentUser, state, render, all the delegated event dispatchers).
  renameGlobals: false,
  // KEEP console output — errors that reach me for support have to be
  // legible. Disabling console blinds the whole debugging surface.
  disableConsoleOutput: false,
  // OFF — the check-and-crash pattern can throw infinite loops in some
  // browsers if devtools is opened, which people legitimately open (to
  // print, to inspect the DOM for a screenshot for me, etc.).
  selfDefending: false,
  // OFF — renaming object keys breaks any code that reads element
  // dataset.foo or JSON-payload keys, both of which the app does.
  transformObjectKeys: false,
  numbersToExpressions: true,
  simplify: true,
  target: 'browser',
};

async function processInlineJs(js) {
  const min = await minifyJs(js, {
    format: { comments: false },
    compress: { drop_console: false, drop_debugger: true, passes: 2, sequences: true, unused: true },
    mangle: { toplevel: false }, // toplevel:false so window.* globals survive
  });
  if (min.error) throw min.error;
  const obf = JavaScriptObfuscator.obfuscate(min.code, OBFUSCATE_OPTS);
  return obf.getObfuscatedCode();
}

async function processInlineCss(css) {
  const result = await postcss([cssnano({ preset: 'default' })]).process(css, { from: undefined });
  return result.css;
}

async function replaceAsync(str, re, fn) {
  const parts = [];
  let last = 0;
  const matches = [...str.matchAll(re)];
  for (const m of matches) {
    parts.push(str.slice(last, m.index));
    parts.push(await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return parts.join('');
}

async function processFile(name) {
  const srcPath = path.join(ROOT, name);
  if (!fs.existsSync(srcPath)) return { name, skipped: true };
  const src = fs.readFileSync(srcPath, 'utf8');
  let out = src;

  // <script>…</script> — skip external (src=) tags.
  out = await replaceAsync(out, /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi, async (_, attrs, body) => {
    if (/\bsrc\s*=/i.test(attrs)) return `<script${attrs}>${body}</script>`;
    if (!body.trim()) return `<script${attrs}></script>`;
    try {
      const processed = await processInlineJs(body);
      return `<script${attrs}>${processed}</script>`;
    } catch (e) {
      console.warn(`[build] script in ${name} left as source (minify/obfuscate failed):`, e.message);
      return `<script${attrs}>${body}</script>`;
    }
  });

  // <style>…</style>
  out = await replaceAsync(out, /<style(\b[^>]*)>([\s\S]*?)<\/style>/gi, async (_, attrs, body) => {
    if (!body.trim()) return `<style${attrs}></style>`;
    try {
      const processed = await processInlineCss(body);
      return `<style${attrs}>${processed}</style>`;
    } catch (e) {
      console.warn(`[build] style in ${name} left as source (minify failed):`, e.message);
      return `<style${attrs}>${body}</style>`;
    }
  });

  // Whole-file collapse. JS and CSS already handled; disable their inner
  // minifiers so html-minifier doesn't re-run terser on the obfuscated code
  // (which would sometimes undo the string-array indirection).
  const finalHtml = await minifyHtml(out, {
    collapseWhitespace: true,
    conservativeCollapse: false,
    removeComments: true,
    removeAttributeQuotes: false,
    minifyJS: false,
    minifyCSS: false,
    keepClosingSlash: true,
    caseSensitive: true,
  });

  fs.writeFileSync(path.join(OUT_DIR, name), finalHtml);
  return { name, before: src.length, after: finalHtml.length };
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

(async () => {
  const t0 = Date.now();
  const results = [];
  for (const f of FILES) results.push(await processFile(f));
  const ok = results.filter(r => !r.skipped);
  console.log('┌─────────────────────────┬──────────┬──────────┬───────┐');
  console.log('│ file                    │  before  │   after  │ ratio │');
  console.log('├─────────────────────────┼──────────┼──────────┼───────┤');
  for (const r of ok) {
    const b = humanBytes(r.before).padStart(8);
    const a = humanBytes(r.after).padStart(8);
    const p = ((r.after / r.before) * 100).toFixed(0).padStart(4) + '%';
    console.log(`│ ${r.name.padEnd(23)} │ ${b} │ ${a} │ ${p} │`);
  }
  const skipped = results.filter(r => r.skipped);
  if (skipped.length) console.log('│ skipped (not found):    │ ' + skipped.map(r => r.name).join(', ').padEnd(42) + ' │');
  console.log('└─────────────────────────┴──────────┴──────────┴───────┘');
  console.log(`[build] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(ROOT, OUT_DIR)}/`);
})().catch(e => { console.error('[build] FAILED', e); process.exit(1); });
