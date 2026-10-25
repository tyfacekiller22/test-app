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

// ---------- Two-way switch (segmented control) ----------
// The value lives in a hidden input (id), so forms read and set it like any other field.
// After setting the input's value in code, dispatch a 'sync' event on it to update the buttons.
// options: [[value, label], ...]; the first option is the default.
export function segHtml(id, value, options, label) {
  const val = options.some(([v]) => v === value) ? value : options[0][0];
  return `<input type="hidden" id="${id}" value="${escapeHtml(val)}">
    <div class="seg seg-field" role="radiogroup" aria-label="${escapeHtml(label)}" data-seg-for="${id}">
      ${options.map(([v, l]) => `<button type="button" role="radio" data-v="${escapeHtml(v)}" aria-checked="${v === val}" aria-selected="${v === val}">${escapeHtml(l)}</button>`).join('')}
    </div>`;
}
export function wireSegs(root) {
  for (const seg of root.querySelectorAll('[data-seg-for]')) {
    const input = root.querySelector('#' + seg.dataset.segFor);
    const buttons = [...seg.querySelectorAll('button[data-v]')];
    const sync = () => {
      if (!buttons.some((b) => b.dataset.v === input.value)) input.value = buttons[0].dataset.v;
      for (const b of buttons) {
        const on = String(b.dataset.v === input.value);
        b.setAttribute('aria-checked', on);
        b.setAttribute('aria-selected', on);
      }
    };
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      input.value = b.dataset.v;
      sync();
      input.dispatchEvent(new Event('change'));
    });
    input.addEventListener('sync', sync);
  }
}

// ---------- Full-screen profile pictures ----------
// Tap a character's photo in the chat (top bar, or beside a name in group chats) or on the
// character page to see it full screen. Tap anywhere, press ✕, or swipe down to close.
function openPhoto(src) {
  if (document.querySelector('.viewer.photo-viewer')) return;
  const v = document.createElement('div');
  v.className = 'viewer photo-viewer';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-label', 'Photo');
  v.innerHTML = `<div class="viewer-top">
      <button class="viewer-close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="viewer-stage"><img alt="" draggable="false"></div>`;
  const img = v.querySelector('img');
  img.src = src;
  document.body.appendChild(v);
  const close = () => v.remove();
  v.querySelector('.viewer-close').addEventListener('click', close);
  let sy = 0, dy = 0, dragging = false;
  v.addEventListener('pointerdown', (e) => { dragging = true; sy = e.clientY; dy = 0; img.style.transition = 'none'; });
  v.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = e.clientY - sy;
    if (dy > 0) {
      img.style.transform = `translateY(${dy}px) scale(${Math.max(0.85, 1 - dy / 1500)})`;
      v.style.background = `rgba(0,0,0,${Math.max(0.4, 1 - dy / 400)})`;
    }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (dy > 100) return close();
    if (Math.abs(dy) < 8) return; // a plain tap: the click handler below closes it
    img.style.transition = 'transform 0.18s ease-out';
    img.style.transform = '';
    v.style.background = '';
  };
  v.addEventListener('pointerup', end);
  // Close on the click (not on pointerup) so the tap can't fall through onto the photo underneath.
  v.addEventListener('click', () => { if (Math.abs(dy) < 8) close(); });
  v.addEventListener('pointercancel', () => { dragging = false; img.style.transform = ''; v.style.background = ''; });
}

// Capture phase, so it wins over the button the photo sits inside (the chat title opens settings).
document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.avatar img');
  if (!img || !img.closest('.topbar, .speaker, #photo-preview')) return;
  const src = safePhoto(img.getAttribute('src'));
  if (!src) return;
  e.preventDefault();
  e.stopPropagation();
  openPhoto(src);
}, true);
