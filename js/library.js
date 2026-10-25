// Saved libraries: AI characters, your characters, and situations.
// Stored only on this device. A chat keeps its own copy (snapshot) of what it started with,
// so editing a saved character later doesn't change old chats.

import * as store from './store.js';
import { $, uid, toast, openSheet, avatarHtml, safePhoto, segHtml, wireSegs } from './ui.js';
import { escapeHtml } from './format.js';
import { EXAMPLE_CHAT } from './defaults.js';

export const KINDS = {
  chars: { tab: 'Characters', one: 'AI character', none: 'Write a new character' },
  users: { tab: 'You', one: 'Your character', none: 'Write a new one' },
  situations: { tab: 'Situations', one: 'Situation', none: 'Write a new situation' },
};

// How a saved item maps onto a chat's fields.
export const MAP = {
  chars: { id: 'charId', fields: { name: 'charName', description: 'charDescription', appearance: 'charAppearance', photo: 'charPhoto' } },
  users: { id: 'userCharId', fields: { name: 'userName', description: 'userDescription', appearance: 'userAppearance', photo: 'userPhoto' } },
  situations: { id: 'situationId', fields: { situation: 'situation', openingMessage: 'openingMessage', openingFrom: 'openingFrom' } },
};

export let lib = { chars: [], users: [], situations: [] };

export async function loadLibrary() {
  const saved = await store.get('library');
  if (saved) {
    lib = { chars: [], users: [], situations: [], ...saved };
  } else {
    // First run: start with the example so the pickers have something in them.
    const now = Date.now();
    lib = {
      chars: [{ id: uid(), name: EXAMPLE_CHAT.charName, description: EXAMPLE_CHAT.charDescription, appearance: EXAMPLE_CHAT.charAppearance, photo: '', created: now, updated: now }],
      users: [{ id: uid(), name: EXAMPLE_CHAT.userName, description: EXAMPLE_CHAT.userDescription, photo: '', created: now, updated: now }],
      situations: [{ id: uid(), name: 'Rainy café', situation: EXAMPLE_CHAT.situation, openingMessage: EXAMPLE_CHAT.openingMessage, created: now, updated: now }],
    };
    await saveLibrary();
  }
}

export const saveLibrary = () => store.set('library', lib).catch(() => toast("Couldn't save the library."));

export const find = (kind, id) => (id ? lib[kind].find((x) => x.id === id) : undefined);
export const sorted = (kind) => [...lib[kind]].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

export function addItem(kind, data) {
  const item = { id: uid(), created: Date.now(), updated: Date.now(), ...data };
  lib[kind].push(item);
  saveLibrary();
  return item;
}
export function updateItem(kind, id, data) {
  const item = find(kind, id);
  if (!item) return null;
  Object.assign(item, data, { updated: Date.now() });
  saveLibrary();
  return item;
}
export function removeItem(kind, id) {
  const i = lib[kind].findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [removed] = lib[kind].splice(i, 1);
  saveLibrary();
  return { removed, index: i };
}

// Merge items (from a backup or import) into the library. Same id = replaced.
export function mergeItems(kind, items) {
  let n = 0;
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const clean = { ...it, id: it.id || uid(), name: String(it.name || '').slice(0, 200), photo: safePhoto(it.photo) };
    // Same id, or an identical copy (e.g. the example both phones start with) = replace.
    const content = (x) => Object.keys(MAP[kind].fields).filter((k) => k !== 'photo').map((k) => (x[k] || '').trim()).join('\u0000');
    let i = lib[kind].findIndex((x) => x.id === clean.id);
    if (i < 0) i = lib[kind].findIndex((x) => content(x) === content(clean) && (x.name || '') === clean.name);
    if (i >= 0) lib[kind][i] = clean; else lib[kind].push(clean);
    n++;
  }
  return n;
}

// Saved item → chat fields.
export function toChat(kind, item) {
  const out = { [MAP[kind].id]: item.id };
  for (const [k, chatKey] of Object.entries(MAP[kind].fields)) out[chatKey] = item[k] || '';
  return out;
}
// Chat fields → saved item data.
export function fromChat(kind, chat) {
  const out = {};
  for (const [k, chatKey] of Object.entries(MAP[kind].fields)) out[k] = chat[chatKey] || '';
  if (kind === 'situations') out.name = situationTitle(chat.situation);
  return out;
}
export function situationTitle(text) {
  const t = String(text || '').replace(/\{\{(char|user)\}\}/g, '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] || t;
  return first.length > 40 ? first.slice(0, 38).trimEnd() + '…' : first || 'Situation';
}

// Is there something worth saving to the library?
export function hasContent(kind, chat) {
  if (kind === 'chars') return !!(chat.charName || '').trim();
  if (kind === 'users') return !!(chat.userDescription || '').trim();
  return !!(chat.situation || '').trim();
}
// An existing saved item with exactly the same content (avoids duplicates).
export function sameAs(kind, chat) {
  const data = fromChat(kind, chat);
  return lib[kind].find((it) =>
    Object.keys(MAP[kind].fields).every((k) => k === 'photo' || (it[k] || '').trim() === (data[k] || '').trim()));
}

// ---------- Photos ----------
// Crops a picked or generated photo to a square JPEG (768px: sharp full screen, still cheap to store and back up).
export async function resizePhoto(file, size = 768) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    const out = Math.min(size, s); // never upscale a small picture
    c.width = c.height = out;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
    return c.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// "Who sends the opening message" switch (situations and New chat).
export const openingFromHtml = (id, value) =>
  segHtml(id, value, [['char', 'From the character'], ['user', 'From you']], 'Who sends the opening message');

// ---------- Picker (used in New chat and Chat settings) ----------
export function pickerHtml(kind, selectedId, label = 'Choose from your library') {
  const items = sorted(kind);
  if (!items.length) return '';
  return `<div class="field picker"><label for="p-${kind}">${label}</label>
    <select id="p-${kind}">
      <option value="">${escapeHtml(KINDS[kind].none)}</option>
      ${items.map((it) => `<option value="${it.id}"${it.id === selectedId ? ' selected' : ''}>${escapeHtml(it.name || 'Untitled')}</option>`).join('')}
    </select></div>`;
}

// ---------- Library screen ----------
let tab = 'chars';
let startChatWith = null; // set by app.js: (charId) => open New chat with that character
let makePhoto = null;     // set by app.js: ({ kind, name, description, appearance }) => Promise<image Blob>
let photoAvailable = () => false; // set by app.js: are pictures turned on?

export function initLibrary({ onStartChat, generatePhoto, canGeneratePhoto }) {
  startChatWith = onStartChat;
  makePhoto = generatePhoto || null;
  if (canGeneratePhoto) photoAvailable = canGeneratePhoto;
  $('#lib-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    renderLibrary();
  });
  $('#lib-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-item]');
    if (b) editItemSheet(tab, find(tab, b.dataset.item));
  });
  $('#lib-add').addEventListener('click', () => editItemSheet(tab, null));
  $('#lib-empty-add').addEventListener('click', () => editItemSheet(tab, null));
}

export function renderLibrary() {
  for (const b of document.querySelectorAll('#lib-tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const items = sorted(tab);
  $('#lib-empty').hidden = items.length > 0;
  $('#lib-empty-text').textContent = {
    chars: 'No AI characters saved yet.',
    users: 'No characters for you saved yet. Save who you are in different stories here.',
    situations: 'No situations saved yet. Save settings and scenes you want to reuse.',
  }[tab];
  $('#lib-list').innerHTML = items.map((it) => {
    const snippet = tab === 'situations' ? it.situation : it.description;
    const av = tab === 'situations'
      ? '<span class="avatar sit"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M5 20V10l7-5 7 5v10"/><path d="M10 20v-5h4v5"/></svg></span>'
      : avatarHtml(it.name, it.photo);
    return `<li><button class="chat-item" data-item="${it.id}">${av}
      <span class="chat-item-body"><span class="chat-item-top"><span class="chat-item-name">${escapeHtml(it.name || 'Untitled')}</span></span>
      <span class="chat-item-snippet">${escapeHtml((snippet || '').replace(/\*/g, ''))}</span></span></button></li>`;
  }).join('');
}

function photoFieldHtml(name, photo) {
  return `<div class="photo-row">
      <span id="photo-preview">${avatarHtml(name, photo, 'big')}</span>
      <div class="photo-btns">
        <button class="btn-secondary small" type="button" id="photo-pick">${photo ? 'Change photo' : 'Add photo'}</button>
        ${makePhoto && photoAvailable() ? `<button class="btn-secondary small ai-gen" type="button" id="photo-gen">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>
          <span>${photo ? 'Generate new photo' : 'Generate photo'}</span></button>` : ''}
        <button class="link-btn danger" type="button" id="photo-remove"${photo ? '' : ' hidden'}>Remove</button>
      </div>
      <input type="file" id="photo-file" accept="image/*" hidden>
    </div>`;
}

// prefill: field values to show instead of the saved ones (e.g. a draft from the Creator).
export function editItemSheet(kind, item, { onSaved, prefill } = {}) {
  const isNew = !item;
  const it = { ...(item || {}), ...(prefill || {}) };
  let photo = it.photo || '';
  const v = (k) => escapeHtml(it[k] || '');
  let body;
  if (kind === 'situations') {
    body = `
      <div class="field"><label for="li-name">Name</label><input id="li-name" type="text" value="${v('name')}" placeholder="e.g. Rainy café" autocomplete="off"></div>
      <div class="field"><label for="li-situation">Setting and what's going on</label><textarea id="li-situation" rows="5">${v('situation')}</textarea></div>
      <div class="field"><label for="li-openingMessage">Opening message (optional)</label>
        ${openingFromHtml('li-openingFrom', it.openingFrom)}
        <textarea id="li-openingMessage" rows="3">${v('openingMessage')}</textarea>
        <p class="hint">If it's from you, the chat starts with your message and the character replies to it.</p></div>
      <p class="hint">Tip: write {{char}} and {{user}} to stand in for the two names.</p>`;
  } else {
    body = photoFieldHtml(it.name, photo) + `
      <div class="field"><label for="li-name">Name</label><input id="li-name" type="text" value="${v('name')}" autocomplete="off"></div>
      <div class="field"><label for="li-description">${kind === 'chars' ? 'Personality, background, how they talk' : 'Who you are in the story'}</label>
        <textarea id="li-description" rows="${kind === 'chars' ? 8 : 4}">${v('description')}</textarea>
        ${kind === 'chars' ? '<p class="hint">A couple of example lines in their voice help a lot.</p>' : '<p class="hint">Relationship, history: whatever the character should know about you.</p>'}</div>
      <div class="field"><label for="li-appearance">Appearance (optional)</label>
        <textarea id="li-appearance" rows="3" placeholder="e.g. late 20s, shoulder-length dark curly hair, freckles, slim, usually in a worn denim jacket">${v('appearance')}</textarea>
        <p class="hint">Used in pictures and in the chat. Concrete details keep them looking the same.</p></div>`;
  }
  if (!isNew && !prefill && kind === 'chars') body += `<div class="group"><button class="btn-secondary wide" id="li-start">Start a chat with ${v('name')}</button></div>`;
  if (!isNew && !prefill) body += `<div class="group"><button class="btn-danger wide" id="li-delete">Delete from library</button>
    <p class="hint" style="margin-top:8px">Chats that already use it keep their own copy.</p></div>`;

  const s = openSheet({
    title: (prefill ? (isNew ? 'Save new ' : 'Update ') : isNew ? 'New ' : 'Edit ') + KINDS[kind].one.toLowerCase(),
    body,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="li-save">Save</button>',
  });
  wireSegs(s.el);

  const pick = $('#photo-pick', s.el);
  if (pick) {
    const showPhoto = () => {
      $('#photo-preview', s.el).innerHTML = avatarHtml($('#li-name', s.el).value, photo, 'big');
      pick.textContent = photo ? 'Change photo' : 'Add photo';
      $('#photo-remove', s.el).hidden = !photo;
    };
    pick.addEventListener('click', () => $('#photo-file', s.el).click());
    $('#photo-file', s.el).addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      try { photo = await resizePhoto(f); showPhoto(); } catch { toast("Couldn't open that photo."); }
    });
    $('#photo-remove', s.el).addEventListener('click', () => { photo = ''; showPhoto(); });
    // Generate a profile photo from the name, appearance and description in the form.
    const gen = $('#photo-gen', s.el);
    gen?.addEventListener('click', async () => {
      const name = $('#li-name', s.el).value.trim();
      const appearance = ($('#li-appearance', s.el)?.value || '').trim();
      const description = ($('#li-description', s.el)?.value || '').trim();
      if (!appearance && !description) { toast('Describe how they look first (Appearance).'); return; }
      const label = $('span', gen);
      gen.disabled = true; pick.disabled = true;
      label.textContent = 'Generating…';
      $('#photo-preview', s.el).innerHTML = '<span class="avatar big gen-wait"><span class="spinner"></span></span>';
      try {
        const blob = await makePhoto({ kind, name, description, appearance });
        if (blob) { photo = await resizePhoto(blob); toast('Photo ready. Tap Save to keep it.'); }
      } catch (e) {
        if (e && e.message) toast(e.message, 6000);
      }
      gen.disabled = false; pick.disabled = false;
      label.textContent = photo ? 'Generate new photo' : 'Generate photo';
      showPhoto();
    });
    $('#li-name', s.el).addEventListener('input', () => { if (!photo) showPhoto(); });
  }

  $('#li-start', s.el)?.addEventListener('click', () => { s.close(); startChatWith?.(it.id); });

  $('#li-delete', s.el)?.addEventListener('click', () => {
    const r = removeItem(kind, it.id);
    s.close();
    renderLibrary();
    if (r) toast(`Deleted ${it.name || 'item'}.`, 5000, {
      label: 'Undo',
      onClick: () => { lib[kind].splice(r.index, 0, r.removed); saveLibrary(); renderLibrary(); },
    });
  });

  $('#li-save', s.el).addEventListener('click', () => {
    const data = { name: $('#li-name', s.el).value.trim() };
    if (kind === 'situations') {
      data.situation = $('#li-situation', s.el).value.trim();
      data.openingMessage = $('#li-openingMessage', s.el).value.trim();
      data.openingFrom = $('#li-openingFrom', s.el).value === 'user' ? 'user' : 'char';
      if (!data.name) data.name = situationTitle(data.situation);
      if (!data.situation && !data.openingMessage) { toast('Describe the situation first.'); return; }
    } else {
      data.description = $('#li-description', s.el).value.trim();
      data.appearance = $('#li-appearance', s.el).value.trim();
      data.photo = photo;
      if (!data.name) { toast('Give them a name.'); return; }
    }
    const saved = isNew ? addItem(kind, data) : updateItem(kind, it.id, data);
    s.close();
    renderLibrary();
    toast('Saved.');
    onSaved?.(saved);
  });
}
