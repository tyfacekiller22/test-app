// Companion: stage 1 (core chat).
// Screens: chat list → chat → settings. Data lives only on this device (IndexedDB).

import * as store from './store.js';
import { DEFAULT_SETTINGS, EXAMPLE_CHAT, SETTINGS_VERSION } from './defaults.js';
import { streamChat, abortGeneration, testConnection, ApiError } from './api.js';
import { buildRequest, systemPrompt, textOf, tidy, fill, paragraphs, cutParagraphs } from './prompt.js';
import { parseImport } from './importer.js';
import { renderText, escapeHtml, timeAgo } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- State ----------
let settings = { ...DEFAULT_SETTINGS };
const chats = new Map();      // id → chat
let current = null;           // the open chat
let gen = null;               // { controller, mode, chatId } while a reply is being written

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Saving ----------
async function saveSettings() { await store.set('settings', settings); }

const saveTimers = new Map();
function saveChat(chat, { now = false } = {}) {
  chat.updated = Date.now();
  if (chat.save === false) return;
  clearTimeout(saveTimers.get(chat.id));
  const write = () => store.set('chat:' + chat.id, chat).catch(() => toast("Couldn't save this chat."));
  if (now) write();
  else saveTimers.set(chat.id, setTimeout(write, 400));
}

async function loadAll() {
  const saved = await store.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // Update older saved settings to the new shorter-reply defaults (keeps anything you changed).
  if (saved && (saved.settingsVersion || 1) < 2) {
    if (saved.maxReplyTokens === 300) settings.maxReplyTokens = 200;
    if ((saved.globalInstructions || '').includes('usually 1–3 short paragraphs')) {
      settings.globalInstructions = saved.globalInstructions.replace(
        'usually 1–3 short paragraphs. Go longer only when the moment calls for it.',
        'one or two short paragraphs at most.'
      );
    }
    settings.settingsVersion = SETTINGS_VERSION;
    await saveSettings();
  }
  for (const key of await store.keys()) {
    if (typeof key === 'string' && key.startsWith('chat:')) {
      const c = await store.get(key);
      if (c) chats.set(c.id, c);
    }
  }
}

// ---------- Toast ----------
let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Bottom sheets ----------
function openSheet({ title, body, actions = '' }) {
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
  const close = () => scrim.remove();
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim || e.target.closest('[data-close]')) close();
  });
  root.appendChild(scrim);
  return { el: scrim, close };
}

// ---------- Routing ----------
function show(view) {
  for (const v of ['home', 'chat', 'settings']) $('#view-' + v).hidden = v !== view;
}

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/chat\/(.+)$/);
  if (m && chats.has(m[1])) {
    openChat(chats.get(m[1]));
  } else if (hash === '#/settings') {
    renderSettings();
    show('settings');
  } else {
    current = null;
    renderHome();
    show('home');
  }
}
window.addEventListener('hashchange', route);

// ---------- Home ----------
function renderHome() {
  const list = [...chats.values()].sort((a, b) => b.updated - a.updated);
  $('#home-empty').hidden = list.length > 0;
  $('#chat-list').innerHTML = list
    .map((c) => {
      const last = [...c.messages].reverse().find((m) => textOf(m).trim());
      const snippet = last ? textOf(last).replace(/\*/g, '') : c.situation || '';
      return `<li><button class="chat-item" data-id="${c.id}">
        <span class="avatar">${escapeHtml((c.charName || '?')[0].toUpperCase())}</span>
        <span class="chat-item-body">
          <span class="chat-item-top">
            <span class="chat-item-name">${escapeHtml(c.charName)}${c.save === false ? ' · not saved' : ''}</span>
            <span class="chat-item-time">${timeAgo(c.updated)}</span>
          </span>
          <span class="chat-item-snippet">${escapeHtml(fill(snippet, c))}</span>
        </span>
      </button></li>`;
    })
    .join('');
}

$('#chat-list').addEventListener('click', (e) => {
  const b = e.target.closest('.chat-item');
  if (b) location.hash = '#/chat/' + b.dataset.id;
});
$('#open-settings').addEventListener('click', () => (location.hash = '#/settings'));
$('#new-chat').addEventListener('click', () => newChatSheet());
$('#try-example').addEventListener('click', () => newChatSheet(EXAMPLE_CHAT));

// ---------- Import (Perchance chats, character cards) ----------
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let result;
  try {
    result = parseImport(await file.text());
  } catch (err) {
    toast(err.message || "Couldn't read that file.");
    return;
  }
  importPreview(result);
});

function importPreview({ source, drafts }) {
  const s = openSheet({
    title: `Import from ${source}`,
    body: `<p class="hint">Choose what to bring in. Each one becomes a chat here. The file stays on this device.</p>
      <ul class="import-list">${drafts
        .map((d, i) => `<li><label class="import-row">
          <input type="checkbox" data-i="${i}" checked>
          <span><span class="import-name">${escapeHtml(d.title)}</span>
          <span class="hint">${escapeHtml(d.charName)} · ${d.messages.length} message${d.messages.length === 1 ? '' : 's'}</span></span>
        </label></li>`)
        .join('')}</ul>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="do-import">Import</button>',
  });
  $('#do-import', s.el).addEventListener('click', () => {
    const picked = [...s.el.querySelectorAll('input[data-i]:checked')].map((x) => drafts[Number(x.dataset.i)]);
    let n = 0;
    for (const d of picked) {
      const chat = {
        v: 1,
        id: uid(),
        created: Date.now(),
        updated: Date.now() + n, // keeps the import order in the list
        charName: d.charName,
        charDescription: d.charDescription,
        userName: d.userName || 'User',
        userDescription: d.userDescription || '',
        situation: d.situation || '',
        openingMessage: '',
        chatInstructions: d.chatInstructions || '',
        narratorInstructions: '',
        useGlobal: true,
        save: true,
        auto: true,
        direction: '',
        messages: [],
      };
      chat.messages = d.messages.map((m) => {
        const versions = m.versions && m.versions.length ? m.versions : [m.text];
        const vi = Math.max(0, versions.indexOf(m.text));
        return { id: uid(), role: m.role, versions, vi, ts: Date.now() };
      });
      chats.set(chat.id, chat);
      saveChat(chat, { now: true });
      n++;
    }
    s.close();
    renderHome();
    toast(n ? `Imported ${n} chat${n === 1 ? '' : 's'}.` : 'Nothing selected.');
  });
}

// ---------- Chat setup fields (used by "New chat" and chat settings) ----------
function chatFields(c) {
  const v = (k) => escapeHtml(c[k] || '');
  return `
    <div class="group" style="margin-top:4px">
      <h2>AI character</h2>
      <div class="field"><label for="f-charName">Name</label><input id="f-charName" type="text" value="${v('charName')}" autocomplete="off"></div>
      <div class="field"><label for="f-charDescription">Personality, background, how they talk</label>
        <textarea id="f-charDescription" rows="6">${v('charDescription')}</textarea>
        <p class="hint">A couple of example lines in their voice help a lot.</p></div>
    </div>
    <div class="group">
      <h2>You</h2>
      <div class="field"><label for="f-userName">Your name in the story</label><input id="f-userName" type="text" value="${v('userName')}" autocomplete="off"></div>
      <div class="field"><label for="f-userDescription">Who you are in the story (optional)</label><textarea id="f-userDescription" rows="3">${v('userDescription')}</textarea></div>
    </div>
    <div class="group">
      <h2>Situation</h2>
      <div class="field"><label for="f-situation">Setting and what's going on (optional)</label><textarea id="f-situation" rows="3">${v('situation')}</textarea></div>
      <div class="field"><label for="f-openingMessage">Opening message from the character (optional)</label><textarea id="f-openingMessage" rows="3">${v('openingMessage')}</textarea></div>
    </div>
    <p class="hint">Tip: write {{char}} and {{user}} to stand in for the two names.</p>`;
}
const FIELD_KEYS = ['charName', 'charDescription', 'userName', 'userDescription', 'situation', 'openingMessage'];
function readFields(root, keys) {
  const out = {};
  for (const k of keys) {
    const el = $('#f-' + k, root);
    if (el) out[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function newChatSheet(prefill = {}) {
  const draft = { userName: 'Sam', ...prefill };
  const s = openSheet({
    title: 'New chat',
    body:
      chatFields(draft) +
      `<div class="toggle-row"><div><div class="label">Save this chat on my phone</div><div class="hint">Off = the chat disappears when you close the app.</div></div>
        <input type="checkbox" id="f-save" checked aria-label="Save this chat on my phone"></div>
       ${prefill.charName ? '' : '<p><button class="link-btn" id="fill-example">Fill in the example (Mara)</button></p>'}`,
    actions: '<button class="btn-primary" id="start-chat">Start chat</button>',
  });
  $('#fill-example', s.el)?.addEventListener('click', () => {
    for (const k of FIELD_KEYS) $('#f-' + k, s.el).value = EXAMPLE_CHAT[k];
  });
  $('#start-chat', s.el).addEventListener('click', () => {
    const f = readFields(s.el, FIELD_KEYS);
    if (!f.charName.trim()) { toast('Give the character a name.'); return; }
    if (!f.userName.trim()) f.userName = 'User';
    const chat = {
      v: 1,
      id: uid(),
      created: Date.now(),
      updated: Date.now(),
      ...f,
      chatInstructions: '',
      narratorInstructions: '',
      useGlobal: true,
      save: $('#f-save', s.el).checked,
      auto: true,
      direction: '',
      messages: [],
    };
    if (f.openingMessage.trim()) {
      chat.messages.push({ id: uid(), role: 'char', versions: [fill(f.openingMessage.trim(), chat)], vi: 0, ts: Date.now() });
    }
    chats.set(chat.id, chat);
    saveChat(chat, { now: true });
    s.close();
    location.hash = '#/chat/' + chat.id;
  });
}

// ---------- Chat screen ----------
function openChat(chat) {
  current = chat;
  $('#chat-name').textContent = chat.charName;
  $('#chat-avatar').textContent = (chat.charName || '?')[0].toUpperCase();
  $('#chat-lock').hidden = chat.save !== false;
  $('#direction').value = chat.direction || '';
  updateDirection();
  setAuto(chat.auto !== false, false);
  renderMessages();
  show('chat');
  scrollToBottom(true);
}

function lastMessage() {
  return current?.messages[current.messages.length - 1];
}

function renderMessages() {
  editingId = null;
  const box = $('#messages');
  const msgs = current.messages;
  if (!msgs.length) {
    box.innerHTML = `<p class="notice">Say something to ${escapeHtml(current.charName)}, or tap Narrate to set the scene.<br>Tip: tap any message to edit or delete it.</p>`;
  } else {
    let lastCharIndex = -1;
    msgs.forEach((m, i) => { if (m.role === 'char') lastCharIndex = i; });
    box.innerHTML = msgs.map((m, i) => messageHtml(m, i === lastCharIndex && i === msgs.length - 1)).join('');
  }
  $('#regenerate-label').textContent = lastMessage()?.role === 'char' ? 'Regenerate' : 'Reply';
}

function messageHtml(m, isLatestChar) {
  const streaming = gen && gen.msgId === m.id;
  const body = renderText(textOf(m));
  if (m.role === 'narrator') {
    return `<div class="msg narrator${streaming ? ' typing' : ''}" data-id="${m.id}">${body}</div>`;
  }
  let swipes = '';
  if (m.role === 'char' && isLatestChar && m.versions.length > 1 && !streaming) {
    swipes = `<div class="swipes">
      <button data-swipe="-1" aria-label="Previous version"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <span>${m.vi + 1} / ${m.versions.length}</span>
      <button data-swipe="1" aria-label="Next version"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>`;
  }
  return `<div class="msg ${m.role}" data-id="${m.id}">
    <div class="bubble${streaming ? ' typing' : ''}">${body}</div>${swipes}</div>`;
}

function updateStreaming(m) {
  const el = $(`.msg[data-id="${m.id}"]`);
  if (!el) return renderMessages();
  const target = m.role === 'narrator' ? el : $('.bubble', el);
  const nearBottom = isNearBottom();
  target.innerHTML = renderText(textOf(m));
  if (nearBottom) scrollToBottom();
}

function isNearBottom() {
  const b = $('#messages');
  return b.scrollHeight - b.scrollTop - b.clientHeight < 120;
}
function scrollToBottom(force = false) {
  const b = $('#messages');
  if (force || isNearBottom()) requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
}

// Swiping between versions of the latest reply.
function swipe(m, dir) {
  const next = m.vi + dir;
  if (next < 0) return;
  if (next >= m.versions.length) { generate('regenerate'); return; }
  m.vi = next;
  saveChat(current);
  renderMessages();
}

$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-swipe]');
  if (!b) return;
  const m = current.messages.find((x) => x.id === b.closest('.msg').dataset.id);
  if (m) swipe(m, Number(b.dataset.swipe));
});

// Long-press (or right-click) a message for options; horizontal swipe on the latest reply.
(function messageGestures() {
  const box = $('#messages');
  let timer = null, startX = 0, startY = 0, target = null, longPressed = false;
  const cancel = () => { clearTimeout(timer); timer = null; target?.classList.remove('pressed'); };

  box.addEventListener('pointerdown', (e) => {
    target = e.target.closest('.msg');
    if (!target || e.target.closest('button, .inline-editor') || e.button !== 0) { target = null; return; }
    startX = e.clientX; startY = e.clientY; longPressed = false;
    target.classList.add('pressed');
    timer = setTimeout(() => {
      longPressed = true;
      target.classList.remove('pressed');
      messageMenu(target.dataset.id);
    }, 480);
  });
  box.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) cancel();
  });
  box.addEventListener('pointerup', (e) => {
    const wasTarget = target;
    cancel();
    if (longPressed || !wasTarget || gen) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    // A simple tap opens the message for editing.
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) { startInlineEdit(wasTarget.dataset.id); return; }
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const m = current.messages.find((x) => x.id === wasTarget.dataset.id);
      if (m && m === lastMessage() && m.role === 'char') swipe(m, dx < 0 ? 1 : -1);
    }
  });
  box.addEventListener('pointercancel', cancel);
  box.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.msg');
    if (!t) return;
    e.preventDefault();
    if (longPressed) return; // the long-press already opened the menu
    cancel();
    longPressed = true;
    messageMenu(t.dataset.id);
  });
})();

function messageMenu(id) {
  if (gen) return;
  const i = current.messages.findIndex((m) => m.id === id);
  if (i < 0) return;
  const m = current.messages[i];
  const isLast = i === current.messages.length - 1;
  const s = openSheet({
    title: m.role === 'user' ? 'Your message' : m.role === 'narrator' ? 'Narration' : current.charName + "'s message",
    body: `<ul class="menu">
      <li><button data-act="edit">Edit</button></li>
      <li><button data-act="copy">Copy text</button></li>
      ${m.role !== 'user' && isLast ? '<li><button data-act="regen">Regenerate</button></li>' : ''}
      <li><button data-act="delete" class="danger">Delete this message</button></li>
      ${!isLast ? '<li><button data-act="delete-after" class="danger">Delete this and everything after</button></li>' : ''}
    </ul>`,
  });
  s.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    s.close();
    if (act === 'edit') startInlineEdit(m.id);
    if (act === 'copy') { try { await navigator.clipboard.writeText(textOf(m)); toast('Copied.'); } catch { toast("Couldn't copy."); } }
    if (act === 'regen') generate(m.role === 'narrator' ? 'renarrate' : 'regenerate');
    if (act === 'delete') { current.messages.splice(i, 1); saveChat(current); renderMessages(); }
    if (act === 'delete-after') { current.messages.splice(i); saveChat(current); renderMessages(); }
  });
}

// Tap a message: edit it right where it is, or delete it.
let editingId = null;
function startInlineEdit(id) {
  if (gen) return;
  if (editingId) renderMessages(); // close any other open editor
  const m = current.messages.find((x) => x.id === id);
  const el = $(`.msg[data-id="${id}"]`);
  if (!m || !el) return;
  editingId = id;
  el.classList.add('editing');
  el.innerHTML = `<div class="inline-editor">
      <label class="sr-only" for="inline-text">Edit message</label>
      <textarea id="inline-text">${escapeHtml(textOf(m))}</textarea>
      <div class="inline-actions">
        <button class="ie-btn danger" data-ie="delete">Delete</button>
        <button class="ie-btn" data-ie="more">More</button>
        <span class="ie-spacer"></span>
        <button class="ie-btn" data-ie="cancel">Cancel</button>
        <button class="ie-btn primary" data-ie="save">Save</button>
      </div>
    </div>`;
  const ta = $('#inline-text', el);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; };
  ta.addEventListener('input', fit);
  fit();
  ta.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ie]');
  if (!b || !editingId) return;
  const i = current.messages.findIndex((x) => x.id === editingId);
  const m = current.messages[i];
  const act = b.dataset.ie;
  const id = editingId;
  if (act === 'save') {
    m.versions[m.vi ?? 0] = $('#inline-text').value.trim();
    saveChat(current);
  }
  if (act === 'delete') {
    if (!confirm('Delete this message?')) return;
    current.messages.splice(i, 1);
    saveChat(current);
  }
  editingId = null;
  renderMessages();
  if (act === 'more') messageMenu(id);
});

// ---------- "What happens next" direction ----------
function updateDirection() {
  const active = !!$('#direction').value.trim();
  $('#direction-box').classList.toggle('active', active);
  $('#clear-direction').hidden = !active;
}
$('#direction').addEventListener('input', () => {
  current.direction = $('#direction').value;
  updateDirection();
  saveChat(current);
});
$('#direction').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#clear-direction').addEventListener('click', () => {
  $('#direction').value = '';
  current.direction = '';
  updateDirection();
  saveChat(current);
});

// ---------- Auto-respond switch ----------
function setAuto(on, save = true) {
  $('#auto').setAttribute('aria-checked', String(on));
  if (current) current.auto = on;
  if (save && current) saveChat(current);
}
$('#auto').addEventListener('click', () => setAuto($('#auto').getAttribute('aria-checked') !== 'true'));

// ---------- Sending ----------
async function send() {
  if (gen) return stopGenerating();
  const box = $('#message');
  const text = box.value.trim();
  if (text) {
    current.messages.push({ id: uid(), role: 'user', versions: [text], vi: 0, ts: Date.now() });
    box.value = '';
    saveChat(current);
    renderMessages();
    scrollToBottom(true);
    if (current.auto !== false) generate('reply');
  } else {
    // Empty box: let the character continue (follows the direction box if filled in).
    generate('reply');
  }
}
$('#send').addEventListener('click', send);
$('#message').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});

$('#regenerate').addEventListener('click', () => generate(lastMessage()?.role === 'char' ? 'regenerate' : 'reply'));
$('#write-for-me').addEventListener('click', () => generate('writeForMe'));

// Narrate: tap = describe the scene; long-press = add a one-time focus first.
(function narrateButton() {
  const btn = $('#narrate');
  let timer = null, long = false;
  btn.addEventListener('pointerdown', () => {
    long = false;
    timer = setTimeout(() => { long = true; narrateFocusSheet(); }, 480);
  });
  const clear = () => clearTimeout(timer);
  btn.addEventListener('pointerup', clear);
  btn.addEventListener('pointerleave', clear);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', () => { if (!long) generate('narrate'); });
})();

function narrateFocusSheet() {
  const s = openSheet({
    title: 'Narrate with a focus',
    body: `<div class="field"><label for="narr-focus">What should the narrator focus on?</label>
      <input id="narr-focus" type="text" placeholder="e.g. her expression, the room, the weather" autocomplete="off"></div>`,
    actions: '<button class="btn-primary" id="do-narrate">Narrate</button>',
  });
  setTimeout(() => $('#narr-focus', s.el).focus(), 50);
  $('#do-narrate', s.el).addEventListener('click', () => {
    const focus = $('#narr-focus', s.el).value.trim();
    s.close();
    generate('narrate', { focus });
  });
}

// ---------- Generating replies ----------
function setGenerating(on) {
  $('#view-chat').classList.toggle('generating', on);
  $('#send').setAttribute('aria-label', on ? 'Stop' : 'Send');
}

async function stopGenerating() {
  if (!gen) return;
  gen.controller.abort();
  abortGeneration(settings);
}

/**
 * mode: 'reply' | 'regenerate' | 'narrate' | 'renarrate' | 'writeForMe'
 */
async function generate(mode, opts = {}) {
  if (gen || !current) return;
  const chat = current;
  const msgs = chat.messages;
  let target = null;       // message being written into
  let history = msgs;
  let apiMode = mode;

  if (mode === 'regenerate' || mode === 'renarrate') {
    target = msgs[msgs.length - 1];
    if (!target || target.role === 'user') return generate('reply');
    history = msgs.slice(0, -1);
    target.versions.push('');
    target.vi = target.versions.length - 1;
    apiMode = target.role === 'narrator' ? 'narrate' : 'reply';
  } else if (mode === 'reply' || mode === 'narrate') {
    target = { id: uid(), role: mode === 'narrate' ? 'narrator' : 'char', versions: [''], vi: 0, ts: Date.now() };
    msgs.push(target);
  }

  const { messages, stop, trimmed } = buildRequest(chat, settings, history, apiMode, opts);
  const controller = new AbortController();
  gen = { controller, mode, chatId: chat.id, msgId: target?.id };
  setGenerating(true);
  if (target) { renderMessages(); scrollToBottom(true); }
  if (trimmed) toast(`Older messages are past the model's memory limit (${trimmed} left out).`);

  const box = $('#message');
  const before = box.value;
  const maxP = apiMode === 'reply' ? Number(settings.maxParagraphs) || 0 : 0;
  let text = '';
  try {
    text = await streamChat(settings, messages, {
      signal: controller.signal,
      stop,
      onText: (t) => {
        // Reply too long: stop as soon as an extra paragraph starts.
        if (maxP && paragraphs(t).length > maxP && !controller.signal.aborted) {
          controller.abort();
          abortGeneration(settings);
          t = cutParagraphs(t, maxP);
        }
        if (current !== chat) return;
        if (target) {
          target.versions[target.vi] = t;
          updateStreaming(target);
        } else {
          box.value = (before ? before + '\n' : '') + t;
        }
      },
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'aborted')) toast(e.message || 'Something went wrong.');
  }

  text = cutParagraphs(tidy(text, chat, apiMode), maxP);
  if (target) {
    if (text) {
      target.versions[target.vi] = text;
    } else if (target.versions.length > 1) {
      target.versions.pop();          // nothing came back: drop the empty version
      target.vi = target.versions.length - 1;
    } else {
      chat.messages.splice(chat.messages.indexOf(target), 1);
    }
  } else if (mode === 'writeForMe') {
    box.value = (before ? before + '\n' : '') + text;
    box.focus();
  }

  gen = null;
  setGenerating(false);
  saveChat(chat);
  if (current === chat) { renderMessages(); scrollToBottom(); }

  // After a narration, the character reacts if Auto is on.
  if (mode === 'narrate' && text && chat.auto !== false && current === chat) generate('reply');
}

// ---------- Chat settings (⋯ or tap the name) ----------
function chatSettingsSheet() {
  const c = current;
  const s = openSheet({
    title: 'Chat settings',
    body:
      chatFields(c).replace(/<div class="field"><label for="f-openingMessage">[\s\S]*?<\/div>/, '') +
      `<div class="group">
        <h2>Instructions</h2>
        <div class="field"><label for="f-chatInstructions">Instructions for this chat only</label>
          <textarea id="f-chatInstructions" rows="3" placeholder="Rules that apply only to this chat">${escapeHtml(c.chatInstructions || '')}</textarea></div>
        <div class="field"><label for="f-narratorInstructions">Narrator instructions for this chat</label>
          <textarea id="f-narratorInstructions" rows="2" placeholder="Leave empty to use the default from Settings">${escapeHtml(c.narratorInstructions || '')}</textarea></div>
        <div class="toggle-row"><div><div class="label">Use global instructions</div><div class="hint">The rules from Settings that apply to every chat.</div></div>
          <input type="checkbox" id="f-useGlobal" ${c.useGlobal !== false ? 'checked' : ''} aria-label="Use global instructions"></div>
        <div class="toggle-row"><div><div class="label">Save this chat on my phone</div><div class="hint">Turning this off deletes the saved copy now.</div></div>
          <input type="checkbox" id="f-save" ${c.save !== false ? 'checked' : ''} aria-label="Save this chat on my phone"></div>
      </div>
      <div class="group">
        <button class="btn-secondary wide" id="view-prompt">View full prompt</button>
      </div>
      <div class="group">
        <button class="btn-danger wide" id="delete-chat">Delete chat</button>
      </div>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="save-chat-settings">Save</button>',
  });

  $('#view-prompt', s.el).addEventListener('click', () => {
    const preview = { ...c, ...readFields(s.el, ['charName', 'charDescription', 'userName', 'userDescription', 'situation', 'chatInstructions', 'narratorInstructions', 'useGlobal']) };
    openSheet({ title: 'Full prompt', body: `<p class="hint">This is everything the model is told before the chat history. Nothing else is added except your "what happens next" direction.</p><pre class="prompt-view">${escapeHtml(systemPrompt(preview, settings))}</pre>` });
  });

  $('#delete-chat', s.el).addEventListener('click', async () => {
    if (!confirm(`Delete this chat with ${c.charName}? This can't be undone.`)) return;
    chats.delete(c.id);
    await store.del('chat:' + c.id);
    s.close();
    location.hash = '#/';
  });

  $('#save-chat-settings', s.el).addEventListener('click', async () => {
    const f = readFields(s.el, ['charName', 'charDescription', 'userName', 'userDescription', 'situation', 'chatInstructions', 'narratorInstructions', 'useGlobal', 'save']);
    if (!f.charName.trim()) { toast('The character needs a name.'); return; }
    const wasSaved = c.save !== false;
    Object.assign(c, f);
    if (wasSaved && !c.save) await store.del('chat:' + c.id);
    saveChat(c, { now: true });
    s.close();
    openChat(c);
  });
}
$('#chat-more').addEventListener('click', chatSettingsSheet);
$('#chat-title').addEventListener('click', chatSettingsSheet);
$('#chat-back').addEventListener('click', () => (location.hash = '#/'));

// ---------- App settings ----------
const NUM_FIELDS = [
  ['maxParagraphs', 'Max paragraphs per reply', 'Replies stop after this many. 0 = no limit.'],
  ['maxReplyTokens', 'Max reply length (tokens)', 'Hard limit. 200 ≈ two short paragraphs.'],
  ['contextSize', 'Memory size (tokens)', "Must match --contextsize on the pod."],
  ['temperature', 'Temperature', 'Creativity. Around 1.0; below 0.7 gets flat.'],
  ['minP', 'Min-P', 'Cuts unlikely words. 0.05 is a good start.'],
  ['dryMultiplier', 'DRY strength', 'Discourages repeated phrases. 0 = off.'],
  ['dryBase', 'DRY base', ''],
  ['dryAllowedLength', 'DRY allowed length', ''],
  ['xtcThreshold', 'XTC threshold', ''],
  ['xtcProbability', 'XTC probability', 'Sometimes skips the most predictable word. 0 = off.'],
  ['topP', 'Top-P', '1 = off'],
  ['topK', 'Top-K', '0 = off'],
  ['repPen', 'Repetition penalty', '1 = off (DRY works better)'],
];

function renderSettings() {
  const v = (k) => escapeHtml(String(settings[k] ?? ''));
  $('#settings-form').innerHTML = `
    <div class="group">
      <h2>Your pod</h2>
      <div class="field"><label for="s-podUrl">Pod address</label>
        <input id="s-podUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://xxxxxxxx-5001.proxy.runpod.net" value="${v('podUrl')}">
        <p class="hint">In Runpod: your pod → Connect → right-click the port 5001 link and copy it.</p></div>
      <div class="field"><label for="s-password">Pod password</label>
        <input id="s-password" type="password" autocomplete="off" value="${v('password')}"></div>
      <div class="row"><button class="btn-secondary" id="test-conn">Test connection</button><span class="status" id="conn-status"></span></div>
    </div>
    <div class="group">
      <h2>Global instructions</h2>
      <div class="field"><label for="s-globalInstructions" class="sr-only">Global instructions</label>
        <textarea id="s-globalInstructions" rows="12">${v('globalInstructions')}</textarea>
        <p class="hint">Rules for every chat. {{char}} and {{user}} become the names.</p></div>
      <div class="field"><label for="s-narratorInstructions">Default narrator instructions</label>
        <textarea id="s-narratorInstructions" rows="3">${v('narratorInstructions')}</textarea></div>
    </div>
    <div class="group">
      <h2>Banned phrases</h2>
      <div class="field"><label for="s-bannedPhrases" class="sr-only">Banned phrases</label>
        <textarea id="s-bannedPhrases" rows="8" autocapitalize="off" spellcheck="false">${v('bannedPhrases')}</textarea>
        <p class="hint">One per line. The model can never write these.</p></div>
    </div>
    <div class="group">
      <h2>Model settings</h2>
      <div class="grid2">
        ${NUM_FIELDS.map(([k, label, hint]) => `<div class="field"><label for="s-${k}">${label}</label>
          <input id="s-${k}" type="number" inputmode="decimal" step="any" value="${v(k)}">${hint ? `<p class="hint">${hint}</p>` : ''}</div>`).join('')}
      </div>
    </div>
    <div class="group">
      <button class="btn-danger wide" id="reset-settings">Reset writing and model settings to defaults</button>
      <p class="hint" style="margin-top:8px">Keeps your pod address and password.</p>
    </div>`;

  $('#settings-form').oninput = (e) => {
    const id = e.target.id;
    if (!id?.startsWith('s-')) return;
    const key = id.slice(2);
    settings[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    saveSettings();
  };
  $('#test-conn').onclick = async () => {
    const st = $('#conn-status');
    st.className = 'status';
    st.textContent = 'Checking…';
    const r = await testConnection(settings);
    st.className = 'status ' + (r.ok ? 'ok' : 'bad');
    st.textContent = r.message;
  };
  $('#reset-settings').onclick = async () => {
    if (!confirm('Reset instructions, banned phrases and model settings to the defaults?')) return;
    settings = { ...DEFAULT_SETTINGS, podUrl: settings.podUrl, password: settings.password };
    await saveSettings();
    renderSettings();
    toast('Settings reset.');
  };
}
$('#settings-back').addEventListener('click', () => (location.hash = '#/'));

// ---------- Keyboard handling (iPhone) ----------
// Keep the app exactly as tall as the visible area, so the composer sits
// right above the keyboard and the latest messages stay in view.
function fitToViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
  window.scrollTo(0, 0);
  if (current) scrollToBottom();
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitToViewport);
  visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
}
window.addEventListener('resize', fitToViewport);

// ---------- Start ----------
(async function start() {
  fitToViewport();
  try {
    await loadAll();
  } catch (e) {
    toast("Couldn't open saved data on this device.");
  }
  store.requestPersistence();
  route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
