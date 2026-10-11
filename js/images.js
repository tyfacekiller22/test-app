// Pictures made in chats. Stored on this device separately from the chat itself
// (key "img:<id>"), so saving a chat stays fast even with many pictures.
// Pictures in chats set to "don't save" are kept in memory only.

import * as store from './store.js';

const cache = new Map(); // id → data URL

export async function getImage(id) {
  if (cache.has(id)) return cache.get(id);
  try {
    const v = await store.get('img:' + id);
    if (v) cache.set(id, v);
    return v || null;
  } catch {
    return null;
  }
}
export const cachedImage = (id) => cache.get(id) || null;

export async function putImage(id, dataUrl, persist = true) {
  cache.set(id, dataUrl);
  if (persist) await store.set('img:' + id, dataUrl);
}

// Writes pictures that were only in memory (a chat switched from "don't save" to "save").
export async function persistImages(ids) {
  for (const id of ids) {
    const v = cache.get(id);
    if (v) await store.set('img:' + id, v).catch(() => {});
  }
}

// Removes saved pictures no chat refers to any more (deleted messages or chats).
export async function cleanupImages(referenced) {
  try {
    for (const key of await store.keys()) {
      if (typeof key === 'string' && key.startsWith('img:') && !referenced.has(key.slice(4))) await store.del(key);
    }
  } catch { /* try again next time */ }
}

export const imageIdsOf = (chat) => chat.messages.flatMap((m) => (m.role === 'image' ? m.images || [] : []));

// PNG from the pod → smaller JPEG for storing on the phone (about 5× smaller).
export async function toJpeg(b64png, quality = 0.88) {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64png;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', quality);
}

// Save to Photos: the iPhone share sheet ("Save Image"), or a download elsewhere.
export async function shareImage(dataUrl, name = 'picture.jpg') {
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
