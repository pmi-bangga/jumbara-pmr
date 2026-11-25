import { jsonError } from './helpers.js';

const COOKIE_NAME = 'jumbara_session';

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret || 'jumbara-pmr-default-secret-key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createSessionCookie(userId, env, request) {
  const payload = JSON.stringify({ uid: Number(userId), exp: Date.now() + 7 * 86400 * 1000 });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await getHmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  const isHttps = new URL(request.url).protocol === 'https:';
  return `${COOKIE_NAME}=${payloadB64}.${sigB64}; Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

export function clearSessionCookie(request) {
  const isHttps = new URL(request.url).protocol === 'https:';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? '; Secure' : ''}`;
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const map = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return map;
}

async function verifySessionToken(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await getHmacKey(env.SESSION_SECRET);
    const sigBytes = base64UrlDecode(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (!payload.uid || (payload.exp && Date.now() > payload.exp)) return null;
    return Number(payload.uid);
  } catch {
    return null;
  }
}

export async function getOptionalAuth(env, request) {
  const cookies = parseCookies(request);
  const userId = await verifySessionToken(cookies[COOKIE_NAME], env);
  if (!userId) return null;

  const user = await env.DB.prepare(
    'SELECT id, username, nama, peran, no_wa, wajib_ganti_password, created_at FROM akun WHERE id = ?'
  ).bind(userId).first();
  if (!user) return null;

  return {
    ...user,
    id: Number(user.id),
    wajib_ganti_password: Boolean(user.wajib_ganti_password),
  };
}

export async function requireAuth(env, request, allowedRoles = null) {
  const user = await getOptionalAuth(env, request);
  if (!user) {
    return { error: jsonError('Silakan login terlebih dahulu.', 401) };
  }
  if (allowedRoles && !allowedRoles.includes(user.peran)) {
    return { error: jsonError('Anda tidak memiliki izin untuk mengakses fitur ini.', 403) };
  }
  return { user };
}
