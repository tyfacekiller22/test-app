// Small shared UI helpers: element lookup, toasts, bottom sheets, avatars, ids.

import { escapeHtml } from './format.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Toast ----------
let toastTimer;
// action: optional { label, onClick } shows a button in the toast (e.g. Undo).
export function toast(msg, ms = 3500, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.onClick(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Bottom sheets ----------
// onClose: called once when the sheet closes (any way: ✕, tapping outside, or close()).
export function openSheet({ title, body, actions = '', onClose = null }) {
  const root = $('#sheet-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="sheet-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="icon-btn" data-close aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="sheet-body">${body}</div>
      ${actions ? `<div class="sheet-actions">${actions}</div>` : ''}
    </div>`;
  let closed = false;
  const close = () => { if (closed) return; closed = true; scrim.remove(); onClose?.(); };
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim || e.target.closest('[data-close]')) close();
  });
  root.appendChild(scrim);
  return { el: scrim, close };
}

// ---------- Avatars ----------
// Only photos this app made itself (data:image/…) are shown.
export const safePhoto = (p) => (typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p) ? p : '');

export function avatarInner(name, photo) {
  const p = safePhoto(photo);
  return p ? `<img src="${p}" alt="">` : escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
}
export function avatarHtml(name, photo, extra = '') {
  return `<span class="avatar${extra ? ' ' + extra : ''}">${avatarInner(name, photo)}</span>`;
}

// Long-press (and right-click) on elements matching `selector` inside `root`.
// Returns a function that tells a click handler whether the click was really the end of a long-press.
export function onLongPress(root, selector, fn, ms = 480) {
  let timer = null, sx = 0, sy = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', (e) => {
    const t = e.target.closest(selector);
    fired = false;
    if (!t || e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; timer = null; fn(t); }, ms);
  });
  root.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
  });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('contextmenu', (e) => {
    const t = e.target.closest(selector);
    if (!t) return;
    e.preventDefault();
    if (fired) return;
    cancel();
    fired = true;
    fn(t);
  });
  return () => { const f = fired; fired = false; return f; };
}
