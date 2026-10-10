// Backups: everything (settings, library, saved chats) in one file.
// Optional password protection uses the browser's built-in encryption (AES-GCM,
// key made from your password with PBKDF2). Without the password the file can't be read.

export const FORMAT = 'companion-backup';
const ITERATIONS = 250000;

export const isBackup = (json) => json && json.format === FORMAT;

export function buildBackup({ settings, library, chats, includeChats, includePod, appVersion }) {
  const s = { ...settings };
  if (!includePod) { delete s.podUrl; delete s.password; }
  return {
    format: FORMAT,
    version: 1,
    appVersion,
    created: new Date().toISOString(),
    settings: s,
    library,
    // Chats set to "don't save" are never included.
    chats: includeChats ? chats.filter((c) => c.save !== false) : [],
  };
}

// ---------- Encryption ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function keyFrom(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(backup, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(backup))));
  return {
    format: FORMAT,
    encrypted: true,
    created: backup.created,
    kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt) },
    iv: toB64(iv),
    data: toB64(data),
  };
}

export async function decryptBackup(file, password) {
  const key = await keyFrom(password, fromB64(file.kdf.salt), file.kdf.iterations || ITERATIONS);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new Error('Wrong password, or the file is damaged.');
  }
}

// ---------- Saving the file ----------
// On iPhone the share sheet is the reliable way ("Save to Files" or iCloud Drive).
// Elsewhere it's a normal download.
export async function saveFile(text, name) {
  const file = new File([text], name, { type: 'application/json' });
  const touch = navigator.maxTouchPoints > 0;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // Otherwise fall through to a normal download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
