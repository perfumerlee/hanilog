/* global process, Buffer, URL, console */
import { loadEnv } from 'vite';

const expectedUrl = 'https://vxgdewxqtbuychrvunjr.supabase.co';
const fileEnv = loadEnv('staging', process.cwd(), '');
const env = (name) => process.env[name] ?? fileEnv[name];
const urlValue = env('VITE_SUPABASE_URL');
const key = env('VITE_SUPABASE_PUBLISHABLE_KEY') ?? '';

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

if (!validUrl) throw new Error('Pages build refused: the Supabase URL is not the approved Staging project.');
if (!key || key.startsWith('sb_secret_') || isServiceRoleJwt(key)) {
  throw new Error('Pages build refused: provide a browser Publishable Key, never a server key.');
}
if (env('PAGES_BASE_PATH') !== 'hanilog') throw new Error('Pages build refused: unexpected GitHub Pages base path.');
if (env('VITE_DEMO_MODE') !== 'false') throw new Error('Pages build refused: Demo mode must not be used for the Staging deployment.');
if (env('VITE_PET_PROFILE_PHOTO_UPLOAD_ENABLED') !== 'false') {
  throw new Error('Pages build refused: profile photo upload must remain paused while the hosted 503 is unresolved.');
}

console.log('Build inputs validated: HTTPS Staging URL, browser key present, Demo off, photo upload paused, /hanilog/ base.');
