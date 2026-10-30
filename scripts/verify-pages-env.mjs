/* global process, Buffer, URL, console */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.env.HANILOG_DEPLOY_TARGET ?? 'staging';
if (!['staging', 'production'].includes(target)) throw new Error('Unknown deployment target.');
const expectedRef = target === 'production' ? 'lfbcxtaqpnbvxpsoywtg' : 'vxgdewxqtbuychrvunjr';
const expectedUrl = "https://" + expectedRef + '.supabase.co';
// This validator runs before npm ci in GitHub Actions, so it must not depend on
// Vite or any package in node_modules. Parse only the simple KEY=value syntax
// used by local Staging env files; process environment always has precedence.
const fileEnv = {};
for (const file of ['.env', '.env.local', '.env.' + target, '.env.' + target + '.local']) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fileEnv[match[1]] = value;
  }
}
const env = (name) => process.env[name] ?? fileEnv[name];
const urlValue = env('VITE_SUPABASE_URL');
const key = env('VITE_SUPABASE_PUBLISHABLE_KEY') ?? '';
if (key.startsWith('eyJ')) {
  let payload;
  try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('Invalid browser JWT.'); }
  if (payload.role !== 'anon' || payload.ref !== expectedRef) throw new Error('Browser key does not match the selected project.');
} else if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid publishable key format.');

function isServiceRoleJwt(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

let validUrl = false;
try {
  const parsed = new URL(urlValue);
  validUrl = parsed.protocol === 'https:' && parsed.origin === expectedUrl;
} catch {
  validUrl = false;
}

if (!validUrl) throw new Error('Pages build refused: the Supabase URL is not the selected project.');
if (!key || key.startsWith('sb_secret_') || isServiceRoleJwt(key)) {
  throw new Error('Pages build refused: provide a browser Publishable Key, never a server key.');
}
if (!(target === 'production' ? ['hanilog'] : ['hanilog', 'hanilog-staging']).includes(env('PAGES_BASE_PATH'))) throw new Error('Pages build refused: unexpected GitHub Pages base path.');
if (env('VITE_DEMO_MODE') !== 'false') throw new Error('Pages build refused: Demo mode must not be used for the Staging deployment.');
if (env('VITE_PET_PROFILE_PHOTO_UPLOAD_ENABLED') !== 'false') {
  throw new Error('Pages build refused: profile photo upload must remain paused while the hosted 503 is unresolved.');
}

console.log('Build inputs validated: HTTPS selected project URL, browser key present, Demo off, photo upload paused, /hanilog/ base.');


