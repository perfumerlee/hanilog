/* global process, Buffer, console */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.env.PAGES_ARTIFACT_DIR ?? 'dist';
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}

await walk(root);
if (!files.some((path) => relative(root, path).replaceAll('\\', '/') === 'index.html')) {
  throw new Error('Pages artifact is missing index.html.');
}
const manifestPath = files.find((path) => path.endsWith('manifest.webmanifest'));
if (!manifestPath) throw new Error('Pages artifact is missing the PWA manifest.');

let totalBytes = 0;
const secretKeyPattern = /sb_secret_[A-Za-z0-9_-]{20,}/;
const jwtPattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
for (const path of files) {
  const bytes = await readFile(path);
  totalBytes += bytes.byteLength;
  const text = bytes.toString('utf8');
  const jwtTokens = text.match(jwtPattern) ?? [];
  const hasServiceRoleJwt = jwtTokens.some((token) => {
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role === 'service_role'; }
    catch { return false; }
  });
  if (secretKeyPattern.test(text) || hasServiceRoleJwt) {
    throw new Error(`Pages artifact contains a server credential marker (${relative(root, path)}).`);
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.start_url !== '/hanilog/' || manifest.scope !== '/hanilog/') {
  throw new Error('PWA start_url and scope must both be /hanilog/.');
}
const html = await readFile(join(root, 'index.html'), 'utf8');
if (!html.includes('/hanilog/')) throw new Error('HTML asset paths do not use the GitHub Pages project base.');
if (!files.some((path) => /(?:^|[\\/])sw\.js$/.test(path))) throw new Error('Pages artifact is missing the service worker.');

console.log(`Pages artifact checks passed: ${files.length} files, ${totalBytes} bytes; no server-key marker; PWA scope /hanilog/.`);
