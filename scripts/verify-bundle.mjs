import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { html } = JSON.parse(fs.readFileSync(path.join(root, 'assets/survey/bundle.json')));
const hashes = JSON.parse(fs.readFileSync(path.join(root, 'assets/survey/source-hashes.json')));
assert(hashes['native/web-adapter.js'], 'Native adapter freshness hash is required. Run pnpm bundle:survey.');
assert(!html.includes('navigator.serviceWorker'), 'APK must not use a service worker');
assert(!/<script[^>]+src=/.test(html), 'Scripts must be bundled');
assert(!/<link[^>]+href=/.test(html), 'Styles and icons must be bundled');
assert(!html.includes('indexedDB.open'), 'Native survey must not create plaintext browser storage');
assert(html.includes("connect-src 'none'"), 'Network CSP must be present');
for (const script of html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/g)) {
  assert(script[1].includes('nonce="__BRIDGE_SESSION__"'), 'Every script needs a CSP nonce');
}
for (const [file, expected] of Object.entries(hashes)) {
  const current = file === 'native/web-adapter.js' ? path.join(root, file)
    : path.join(root, '../heritage-inventory', file);
  // EAS staging intentionally contains no sibling app. Locally, fail on stale bundles.
  if (file === 'native/web-adapter.js' || fs.existsSync(current)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex'), expected,
    `Source changed: ${file}. Run pnpm bundle:survey before release.`);
}
console.log('Offline asset and source freshness checks passed.');
