// The Creator: a conversation with the model (in "assistant mode", not roleplaying)
// that helps you build AI characters, characters for you, and situations.
// Drafts come back as cards with a Save button. Nothing is saved until you tap Save
// and confirm in the editor. The conversation is kept only on this device.

import * as store from './store.js';
import { streamChat, abortGeneration, ApiError } from './api.js';
import { $, uid, toast, openSheet, onLongPress } from './ui.js';
import { escapeHtml, renderText } from './format.js';
import * as library from './library.js';
import { lib } from './library.js';

const STORE_KEY = 'creator';
let session = { messages: [] }; // messages: { id, role: 'user' | 'assistant', text, saved?: { [draftIndex]: itemId } }
let loaded = false;
let gen = null;                 // { controller, msgId, userStopped } while the Creator is writing
let deps = null;                // from app.js: { getSettings, apiSettings, readyMessage, startChat }

// Draft blocks the model writes: [[CHARACTER]] … [[END]]
const BLOCK_TO_KIND = { CHARACTER: 'chars', 'AI CHARACTER': 'chars', YOU: 'users', USER: 'users', 'USER CHARACTER': 'users', SITUATION: 'situations' };
const KIND_TO_BLOCK = { chars: 'CHARACTER', users: 'YOU', situations: 'SITUATION' };
const KIND_LABEL = { chars: 'AI character', users: 'Your character', situations: 'Situation' };
const FIELD_LABELS = {
  chars: [['name', 'Name'], ['description', 'Description'], ['appearance', 'Appearance']],
  users: [['name', 'Name'], ['description', 'Description'], ['appearance', 'Appearance']],
  situations: [['name', 'Name'], ['situation', 'Situation'], ['openingMessage', 'Opening message']],
};

// ---------- Parsing drafts ----------
const BLOCK_RE = /\[\[\s*(AI CHARACTER|USER CHARACTER|CHARACTER|YOU|USER|SITUATION)\s*\]\]([\s\S]*?)(\[\[\s*END\s*\]\]|$)/gi;

// Splits a reply into plain text and draft blocks.
export function parseSegments(text) {
  const out = [];
  let last = 0;
  const t = text || '';
  for (const m of t.matchAll(BLOCK_RE)) {
    if (m.index > last) out.push({ type: 'text', text: t.slice(last, m.index) });
    const kind = BLOCK_TO_KIND[m[1].toUpperCase()];
    out.push({ type: 'draft', kind, fields: parseFields(kind, m[2]), complete: /END/i.test(m[3] || '') });
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push({ type: 'text', text: t.slice(last) });
  // Drop stray ``` fences and empty bits around the blocks.
  return out
    .map((s) => (s.type === 'text' ? { ...s, text: s.text.replace(/^\s*```[a-z]*\s*$/gim, '').trim() } : s))
    .filter((s) => s.type !== 'text' || s.text);
}

function parseFields(kind, body) {
  const labels = FIELD_LABELS[kind];
  const names = labels.map(([, l]) => l).concat(['Opening line', 'First message', 'Title']);
  const re = new RegExp(`^\\s*\\**\\s*(${names.join('|')})\\s*\\**\\s*:\\s*\\**\\s*(.*)$`, 'i');
  const out = {};
  let cur = null;
  for (const line of (body || '').split('\n')) {
    const m = line.match(re);
    if (m) {
      const label = m[1].toLowerCase();
      cur = label === 'title' ? 'name'
        : /^(opening|first)/.test(label) ? 'openingMessage'
        : (labels.find(([, l]) => l.toLowerCase() === label) || [])[0];
      if (cur) { out[cur] = m[2]; continue; }
    }
    if (cur) out[cur] = (out[cur] ? out[cur] + '\n' : '') + line;
  }
  for (const k of Object.keys(out)) {
    out[k] = out[k].replace(/^\s*```[a-z]*\s*$/gim, '').trim();
    if (/^\(?(none|leave (it )?empty.*|n\/a|-)\)?\.?$/i.test(out[k])) out[k] = '';
  }
  if (out.name) out.name = out.name.replace(/^["“]|["”]$/g, '').trim();
  return out;
}

// A saved library item as a draft block (to share it with the Creator).
function itemAsBlock(kind, it) {
  const lines = [`[[${KIND_TO_BLOCK[kind]}]]`];
  for (const [k, label] of FIELD_LABELS[kind]) {
    const v = (it[k] || '').trim();
    lines.push(k === 'name' ? `Name: ${v}` : `${label}:\n${v}`);
  }
  lines.push('[[END]]');
  return lines.join('\n');
}

const existingFor = (kind, name) => {
  const n = (name || '').trim().toLowerCase();
  return n ? lib[kind].find((x) => (x.name || '').trim().toLowerCase() === n) : undefined;
};

// ---------- What the model sees ----------
const estTokens = (s) => Math.ceil((s || '').length / 3.5);

function librarySummary() {
  const names = (kind) => lib[kind].map((x) => x.name || 'Untitled').join(', ') || '(none yet)';
  return `The user's library right now (names only; the user can share any of them with you):\n` +
    `- AI characters: ${names('chars')}\n- Characters for the user: ${names('users')}\n- Situations: ${names('situations')}`;
}

function buildMessages(history) {
  const settings = deps.getSettings();
  const system = [(settings.creatorInstructions || '').trim(), librarySummary()].filter(Boolean).join('\n\n');
  let hist = [];
  for (const m of history) {
    const content = (m.text || '').trim();
    if (!content) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = hist[hist.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else hist.push({ role, content });
  }
  const budget = Number(settings.contextSize) - 1000 - 200;
  while (hist.length > 1 && estTokens(system) + hist.reduce((n, m) => n + estTokens(m.content), 0) > budget) hist.shift();
  while (hist.length && hist[0].role === 'assistant') hist.shift();
  return [{ role: 'system', content: system }, ...hist];
}

// Assistant mode: steadier settings than roleplay (no XTC or DRY, which can scramble the
// draft format), and room for a full draft.
function creatorApiSettings() {
  const s = deps.apiSettings();
  return { ...s, temperature: Math.min(Number(s.temperature) || 0.9, 0.9), xtcProbability: 0, dryMultiplier: 0, maxReplyTokens: 1000 };
}

// ---------- Saving ----------
async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = await store.get(STORE_KEY);
    if (saved && Array.isArray(saved.messages)) session = saved;
  } catch { /* start fresh */ }
}
const save = () => store.set(STORE_KEY, session).catch(() => toast("Couldn't save the Creator conversation."));

// ---------- Rendering ----------
const STARTERS = [
  ['An AI character', 'Help me create a new AI character.'],
  ['A situation', 'Help me come up with a new situation for a chat.'],
  ['Who I am in a story', 'Help me write a character for me to play.'],
  ['A group of characters', 'Help me create a small group of characters who know each other, for a group chat.'],
];

export async function renderCreator() {
  await load();
  const box = $('#cr-messages');
  const msgs = session.messages;
  $('#creator-new').hidden = !msgs.length;
  if (!msgs.length) {
    box.innerHTML = `<div class="creator-intro">
        <p class="creator-intro-title">What do you want to make?</p>
        <p class="hint">Talk it through with the Creator. It asks questions, suggests ideas, and writes drafts you can save to your library. It runs on your own model, so the pod needs to be on.</p>
        <div class="starter-list">
          ${STARTERS.map(([label], i) => `<button class="starter" data-starter="${i}">${escapeHtml(label)}</button>`).join('')}
          <button class="starter" data-rework>Rework something saved…</button>
        </div>
        <p class="hint">Or just type an idea below.</p>
      </div>`;
  } else {
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    box.innerHTML = msgs.map((m) => messageHtml(m, m === lastAssistant && m === msgs[msgs.length - 1])).join('');
  }
  setGenerating(!!gen);
}

function messageHtml(m, isLast) {
  const streaming = gen && gen.msgId === m.id;
  const segs = parseSegments(m.text);
  const inner = segs.length
    ? segs.map((s, i) => (s.type === 'text' ? `<div class="cr-text">${renderText(s.text)}</div>` : draftHtml(m, s, i, streaming))).join('')
    : '<div class="cr-text"><p></p></div>';
  const tools = m.role === 'assistant' && isLast && !streaming
    ? `<div class="cr-tools"><button class="link-btn" data-retry>Try again</button></div>` : '';
  return `<div class="msg ${m.role === 'user' ? 'user' : 'char'} cr-msg" data-id="${m.id}">
    <div class="bubble${streaming ? ' typing' : ''}">${inner}</div>${tools}</div>`;
}

function draftHtml(m, d, index, streaming) {
  const f = d.fields;
  const shared = m.role === 'user';
  const done = d.complete || !streaming;
  const fields = FIELD_LABELS[d.kind]
    .filter(([k]) => k !== 'name' && (f[k] || '').trim())
    .map(([k, label]) => `<div class="draft-label">${label}</div><div class="draft-text">${renderText(f[k])}</div>`)
    .join('');
  let actions = '';
  if (shared) {
    actions = '<div class="hint">Shared from your library</div>';
  } else if (!done) {
    actions = '<div class="hint">Writing…</div>';
  } else {
    const existing = existingFor(d.kind, f.name);
    const saved = m.saved && m.saved[index];
    actions = `<div class="draft-actions">
      ${existing
        ? `<button class="btn-primary small" data-save="${index}" data-mode="update">Update “${escapeHtml(existing.name)}”</button>
           <button class="btn-secondary small" data-save="${index}" data-mode="new">Save as new</button>`
        : `<button class="btn-primary small" data-save="${index}" data-mode="new">Review &amp; save</button>`}
      ${saved ? '<span class="saved-pill">Saved</span>' : ''}
    </div>`;
  }
  return `<div class="draft-card${shared ? ' shared' : ''}">
    <div class="draft-kind">${KIND_LABEL[d.kind]}</div>
    <div class="draft-name">${escapeHtml(f.name || 'Untitled')}</div>
    ${fields}
    ${actions}
  </div>`;
}

function updateStreaming(m) {
  const el = $(`#cr-messages .msg[data-id="${m.id}"]`);
  if (!el) return renderCreator();
  const box = $('#cr-messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  el.outerHTML = messageHtml(m, true);
  if (near) box.scrollTop = box.scrollHeight;
}

export function scrollCreatorToBottom() {
  const box = $('#cr-messages');
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}

function setGenerating(on) {
  $('#view-creator').classList.toggle('generating', on);
  $('#cr-send').setAttribute('aria-label', on ? 'Stop' : 'Send');
}

// ---------- Talking to the model ----------
async function generate() {
  if (gen) return;
  const notReady = deps.readyMessage();
  if (notReady) { toast(notReady); return; }
  const target = { id: uid(), role: 'assistant', text: '' };
  const messages = buildMessages(session.messages);
  session.messages.push(target);
  const controller = new AbortController();
  gen = { controller, msgId: target.id, userStopped: false };
  await renderCreator();
  scrollCreatorToBottom();
  try {
    const { text } = await streamChat(creatorApiSettings(), messages, {
      signal: controller.signal,
      onText: (t) => {
        target.text = t;
        if (!$('#view-creator').hidden) updateStreaming(target);
      },
    });
    target.text = (text || '').trim();
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'aborted')) toast(e.message || 'Something went wrong.');
  }
  target.text = (target.text || '').trim();
  if (!target.text) session.messages.splice(session.messages.indexOf(target), 1);
  gen = null;
  save();
  if (!$('#view-creator').hidden) { await renderCreator(); scrollCreatorToBottom(); }
}

function stop() {
  if (!gen) return;
  gen.userStopped = true;
  gen.controller.abort();
  abortGeneration(deps.apiSettings());
}

async function send(text) {
  if (gen) return stop();
  const box = $('#cr-input');
  const t = (text ?? box.value).trim();
  if (!t) return;
  if (deps.readyMessage()) { toast(deps.readyMessage()); return; } // keep the typed text if the pod is off
  if (text === undefined) box.value = '';
  session.messages.push({ id: uid(), role: 'user', text: t });
  save();
  generate();
}

// ---------- Saving drafts to the library ----------
function saveDraft(msgId, index, mode) {
  const m = session.messages.find((x) => x.id === msgId);
  const d = m && parseSegments(m.text)[index];
  if (!d || d.type !== 'draft') return;
  const prefill = {};
  for (const [k] of FIELD_LABELS[d.kind]) prefill[k] = d.fields[k] || '';
  const existing = mode === 'update' ? existingFor(d.kind, d.fields.name) : null;
  library.editItemSheet(d.kind, existing || null, {
    prefill,
    onSaved: (item) => {
      m.saved = { ...(m.saved || {}), [index]: item.id };
      save();
      renderCreator();
      if (d.kind === 'chars') {
        toast(`${existing ? 'Updated' : 'Saved'} ${item.name}.`, 6000, { label: 'Start a chat', onClick: () => deps.startChat(item.id) });
      }
    },
  });
}

// "Rework something saved…": pick a library item and share it with the Creator.
function reworkSheet() {
  const kinds = ['chars', 'users', 'situations'].filter((k) => lib[k].length);
  if (!kinds.length) { toast('Your library is empty. Start with something new.'); return; }
  const s = openSheet({
    title: 'Rework something saved',
    body: kinds.map((k) => `<div class="group" style="margin-top:4px"><h2>${library.KINDS[k].tab}</h2><ul class="menu">
        ${library.sorted(k).map((it) => `<li><button data-kind="${k}" data-id="${it.id}">${escapeHtml(it.name || 'Untitled')}</button></li>`).join('')}
      </ul></div>`).join(''),
  });
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const it = library.find(b.dataset.kind, b.dataset.id);
    s.close();
    if (!it) return;
    const what = KIND_LABEL[b.dataset.kind].toLowerCase();
    send(`Let's work on my saved ${what}, "${it.name || 'Untitled'}". Read it, tell me briefly what's working and what could be stronger, and ask what I'd like to change.\n\n${itemAsBlock(b.dataset.kind, it)}`);
  });
}

function startOver() {
  if (gen) { toast('Wait for the reply to finish (or tap Stop) first.'); return; }
  if (!session.messages.length) return;
  if (!confirm('Start over? This clears the Creator conversation. Anything you saved stays in your library.')) return;
  const before = session;
  session = { messages: [] };
  save();
  renderCreator();
  toast('Conversation cleared.', 6000, { label: 'Undo', onClick: () => { session = before; save(); renderCreator(); } });
}

function messageMenu(id) {
  if (gen) return;
  const i = session.messages.findIndex((m) => m.id === id);
  if (i < 0) return;
  const m = session.messages[i];
  const s = openSheet({
    title: m.role === 'user' ? 'Your message' : "Creator's message",
    body: `<ul class="menu">
      <li><button data-act="copy">Copy text</button></li>
      <li><button data-act="delete" class="danger">Delete this message</button></li>
    </ul>`,
  });
  s.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    s.close();
    if (act === 'copy') { try { await navigator.clipboard.writeText(m.text); toast('Copied.'); } catch { toast("Couldn't copy."); } }
    if (act === 'delete') { session.messages.splice(i, 1); save(); renderCreator(); }
  });
}

// ---------- Setup ----------
export function initCreator(d) {
  deps = d;
  $('#creator-back').addEventListener('click', () => deps.back());
  $('#creator-new').addEventListener('click', startOver);
  $('#cr-send').addEventListener('click', () => send());
  $('#cr-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
  const wasLong = onLongPress($('#cr-messages'), '.cr-msg', (el) => messageMenu(el.dataset.id));
  $('#cr-messages').addEventListener('click', (e) => {
    if (wasLong()) return;
    const starter = e.target.closest('[data-starter]');
    if (starter) return send(STARTERS[Number(starter.dataset.starter)][1]);
    if (e.target.closest('[data-rework]')) return reworkSheet();
    if (e.target.closest('[data-retry]')) {
      const last = session.messages[session.messages.length - 1];
      if (gen || !last || last.role !== 'assistant') return;
      if (deps.readyMessage()) { toast(deps.readyMessage()); return; }
      session.messages.pop();
      return generate();
    }
    const b = e.target.closest('[data-save]');
    if (b) saveDraft(b.closest('.msg').dataset.id, Number(b.dataset.save), b.dataset.mode);
  });
}
