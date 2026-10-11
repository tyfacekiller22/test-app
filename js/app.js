// Companion: stage 1 (core chat).
// Screens: chat list → chat → settings. Data lives only on this device (IndexedDB).

import * as store from './store.js';
import { DEFAULT_SETTINGS, EXAMPLE_CHAT, SETTINGS_VERSION, CREATOR_FORMAT_V3, CREATOR_FORMAT_V4 } from './defaults.js';
import { streamChat, abortGeneration, testConnection, ApiError, txt2img } from './api.js';
import { getImage, cachedImage, putImage, persistImages, cleanupImages, imageIdsOf, toJpeg, shareImage } from './images.js';
import { buildRequest, systemPrompt, textOf, tidy, fill, paragraphs, cutParagraphs, trimIncomplete, castOf, isGroup, castNames, speakerOf, splitSpeaker, buildImagePrompt, parseImagePrompt, finalImagePrompt } from './prompt.js';
import { initCreator, renderCreator, scrollCreatorToBottom } from './creator.js';
import { parseImport } from './importer.js';
import { podControlEnabled, getStatus, startPod, stopPod, keepAlive, recordSession, monthTotal, fmtDuration } from './pod.js';
import { renderText, escapeHtml, timeAgo } from './format.js';
import { $, uid, toast, openSheet, avatarHtml, avatarInner, onLongPress } from './ui.js';
import * as library from './library.js';
import { lib, KINDS, MAP } from './library.js';
import { isBackup, buildBackup, encryptBackup, decryptBackup, saveFile } from './backup.js';

const APP_VERSION = 12; // bump with CACHE in sw.js on each update

// ---------- State ----------
let settings = { ...DEFAULT_SETTINGS };
const chats = new Map();      // id → chat
let current = null;           // the open chat
let gen = null;               // { controller, mode, chatId } while a reply is being written

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
  const oldVersion = saved ? saved.settingsVersion || 1 : SETTINGS_VERSION;
  if (oldVersion < 2 && (saved.globalInstructions || '').includes('usually 1–3 short paragraphs')) {
    settings.globalInstructions = saved.globalInstructions.replace(
      'usually 1–3 short paragraphs. Go longer only when the moment calls for it.',
      'one or two short paragraphs at most.'
    );
  }
  // v3: the token limit is now only a safety net (it was cutting replies off mid-sentence).
  if (oldVersion < 3 && [200, 300].includes(saved.maxReplyTokens)) settings.maxReplyTokens = 400;
  // v4: add the Appearance field to the Creator's draft format (keeps any other edits you made).
  if (oldVersion < 4 && (settings.creatorInstructions || '').includes(CREATOR_FORMAT_V3)) {
    settings.creatorInstructions = settings.creatorInstructions.replace(CREATOR_FORMAT_V3, CREATOR_FORMAT_V4);
  }
  if (oldVersion < SETTINGS_VERSION) {
    settings.settingsVersion = SETTINGS_VERSION;
    await saveSettings();
  }
  await library.loadLibrary();
  for (const key of await store.keys()) {
    if (typeof key === 'string' && key.startsWith('chat:')) {
      const c = await store.get(key);
      if (c) chats.set(c.id, c);
    }
  }
}

// ---------- Routing ----------
function show(view) {
  for (const v of ['home', 'chat', 'settings', 'library', 'creator']) $('#view-' + v).hidden = v !== view;
}

// A chat's display name: "Mara", or "Mara and Jo" for a group.
const chatTitle = (c) => (isGroup(c) ? castNames(c) : c.charName);
// Avatar(s) for a chat: one, or two overlapping for a group.
function chatAvatarInner(c) {
  const cast = castOf(c);
  if (cast.length < 2) return avatarInner(c.charName, c.charPhoto);
  return cast.slice(0, 2).map((x) => `<span class="avatar mini">${avatarInner(x.name, x.photo)}</span>`).join('');
}

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/chat\/(.+)$/);
  if (m && chats.has(m[1])) {
    openChat(chats.get(m[1]));
  } else if (hash === '#/library') {
    library.renderLibrary();
    show('library');
  } else if (hash === '#/create') {
    renderCreator();
    show('creator');
  } else if (hash === '#/settings') {
    renderSettings();
    show('settings');
  } else {
    current = null;
    renderHome();
    show('home');
    if (typeof renderPod === 'function') { renderPod(); refreshPod().then(schedulePoll); }
  }
}
let prevHash = '#/';
window.addEventListener('hashchange', (e) => {
  try { prevHash = new URL(e.oldURL).hash || '#/'; } catch { prevHash = '#/'; }
  route();
});

// ---------- Home ----------
let homeEditing = false;

function renderHome() {
  const list = [...chats.values()].sort((a, b) => b.updated - a.updated);
  $('#home-empty').hidden = list.length > 0;
  $('#home-edit').hidden = !list.length;
  if (!list.length) setHomeEditing(false);
  $('#chat-list').innerHTML = list
    .map((c) => {
      const last = [...c.messages].reverse().find((m) => textOf(m).trim());
      const snippet = last ? textOf(last).replace(/\*/g, '') : c.situation || '';
      return `<li class="chat-row"><button class="chat-item" data-id="${c.id}">
        <span class="avatar${isGroup(c) ? ' stack' : ''}">${chatAvatarInner(c)}</span>
        <span class="chat-item-body">
          <span class="chat-item-top">
            <span class="chat-item-name">${escapeHtml(chatTitle(c))}${c.save === false ? ' · not saved' : ''}</span>
            <span class="chat-item-time">${timeAgo(c.updated)}</span>
          </span>
          <span class="chat-item-snippet">${escapeHtml(fill(snippet, c))}</span>
        </span>
      </button>
      <button class="row-delete" data-delete-chat="${c.id}" aria-label="Delete chat with ${escapeHtml(chatTitle(c))}">Delete</button></li>`;
    })
    .join('');
}

function setHomeEditing(on) {
  homeEditing = on;
  $('#view-home').classList.toggle('home-editing', on);
  $('#home-edit').textContent = on ? 'Done' : 'Edit';
  $('#home-edit').setAttribute('aria-pressed', String(on));
}
$('#home-edit').addEventListener('click', () => setHomeEditing(!homeEditing));

// Deletes a chat, with Undo.
async function deleteChat(c) {
  chats.delete(c.id);
  clearTimeout(saveTimers.get(c.id));
  try { await store.del('chat:' + c.id); } catch { /* already gone */ }
  if (current === c) current = null;
  if (location.hash === '#/' || location.hash === '') renderHome();
  toast(`Deleted chat with ${chatTitle(c)}.`, 6000, {
    label: 'Undo',
    onClick: () => {
      chats.set(c.id, c);
      saveChat(c, { now: true });
      renderHome();
    },
  });
}

const wasLongPress = onLongPress($('#chat-list'), '.chat-item', (b) => {
  const c = chats.get(b.dataset.id);
  if (!c) return;
  const s = openSheet({
    title: chatTitle(c),
    body: `<ul class="menu">
      <li><button data-act="open">Open chat</button></li>
      <li><button data-act="clear" class="danger">Clear conversation</button></li>
      <li><button data-act="delete" class="danger">Delete chat</button></li>
    </ul>`,
  });
  s.el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    s.close();
    if (act === 'open') location.hash = '#/chat/' + c.id;
    if (act === 'clear' && confirm(`Clear the conversation with ${chatTitle(c)}? All messages are deleted. Characters, situation and instructions stay.`)) {
      clearConversation(c);
      renderHome();
    }
    if (act === 'delete') deleteChat(c);
  });
});

$('#chat-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-delete-chat]');
  if (del) { const c = chats.get(del.dataset.deleteChat); if (c) deleteChat(c); return; }
  const b = e.target.closest('.chat-item');
  if (!b || wasLongPress()) return;
  if (homeEditing) { setHomeEditing(false); return; }
  location.hash = '#/chat/' + b.dataset.id;
});
$('#open-library').addEventListener('click', () => (location.hash = '#/library'));
$('#library-back').addEventListener('click', () => (location.hash = '#/'));
$('#open-settings').addEventListener('click', () => (location.hash = '#/settings'));
$('#new-chat').addEventListener('click', () => newChatSheet());
$('#open-creator').addEventListener('click', () => (location.hash = '#/create'));
$('#lib-create').addEventListener('click', () => (location.hash = '#/create'));
$('#try-example').addEventListener('click', () => {
  const pre = {};
  for (const kind of Object.keys(KINDS)) pre[kind] = (library.sorted(kind)[0] || {}).id || '';
  newChatSheet(pre);
});

// ---------- Import (Perchance chats, character cards) ----------
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let text, json = null;
  try {
    text = await file.text();
    try { json = JSON.parse(text); } catch { /* not JSON: let the importer explain */ }
    if (isBackup(json)) return restoreBackup(json);
    importPreview(parseImport(text));
  } catch (err) {
    toast(err.message || "Couldn't read that file.");
  }
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
        .join('')}</ul>
      <div class="toggle-row"><div><div class="label">Also add the characters to my library</div><div class="hint">So you can start new chats with them.</div></div>
        <input type="checkbox" id="import-to-lib" checked aria-label="Also add the characters to my library"></div>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="do-import">Import</button>',
  });
  $('#do-import', s.el).addEventListener('click', () => {
    const picked = [...s.el.querySelectorAll('input[data-i]:checked')].map((x) => drafts[Number(x.dataset.i)]);
    const toLib = $('#import-to-lib', s.el).checked;
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
        direction: d.direction || '',
        messages: [],
      };
      chat.messages = d.messages.map((m) => {
        const versions = m.versions && m.versions.length ? m.versions : [m.text];
        const vi = Math.max(0, versions.indexOf(m.text));
        return { id: uid(), role: m.role, versions, vi, ts: Date.now() };
      });
      if (toLib) linkToLibrary(chat, ['chars', 'users']);
      chats.set(chat.id, chat);
      saveChat(chat, { now: true });
      n++;
    }
    s.close();
    renderHome();
    toast(n ? `Imported ${n} chat${n === 1 ? '' : 's'}.` : 'Nothing selected.');
  });
}

// Saves a chat's characters/situation to the library (or links to an identical saved one).
function linkToLibrary(chat, kinds = ['chars', 'users', 'situations']) {
  for (const kind of kinds) {
    if (chat[MAP[kind].id] || !library.hasContent(kind, chat)) continue;
    const same = library.sameAs(kind, chat);
    const item = same || library.addItem(kind, library.fromChat(kind, chat));
    chat[MAP[kind].id] = item.id;
  }
}

// ---------- Chat setup fields (used by "New chat" and chat settings) ----------
// picks: { chars, users, situations } = selected library ids (or '' for none).
function chatFields(c, { picks = {}, opening = true, pickLabel } = {}) {
  const v = (k) => escapeHtml(c[k] || '');
  const extras = c.extraChars || [];
  return `
    <div class="group" style="margin-top:4px">
      <h2 id="chars-heading">${extras.length ? 'AI characters' : 'AI character'}</h2>
      ${library.pickerHtml('chars', picks.chars, pickLabel)}
      <div class="field"><label for="f-charName">Name</label><input id="f-charName" type="text" value="${v('charName')}" autocomplete="off"></div>
      <div class="field"><label for="f-charDescription">Personality, background, how they talk</label>
        <textarea id="f-charDescription" rows="6">${v('charDescription')}</textarea>
        <p class="hint">A couple of example lines in their voice help a lot.</p></div>
      <div class="field"><label for="f-charAppearance">Appearance (optional)</label>
        <textarea id="f-charAppearance" rows="2" placeholder="Hair, build, age, usual clothes">${v('charAppearance')}</textarea></div>
      <div id="extra-chars">${extras.map((x, i) => extraCharHtml(x, i)).join('')}</div>
      <button class="btn-secondary small" type="button" id="add-char">+ Add another character</button>
      <p class="hint" style="margin-top:6px">For a group scene. The same model plays everyone, so there's no extra cost; replies just start a little slower.</p>
    </div>
    <div class="group">
      <h2>You</h2>
      ${library.pickerHtml('users', picks.users, pickLabel)}
      <div class="field"><label for="f-userName">Your name in the story</label><input id="f-userName" type="text" value="${v('userName')}" autocomplete="off"></div>
      <div class="field"><label for="f-userDescription">Who you are in the story (optional)</label><textarea id="f-userDescription" rows="3">${v('userDescription')}</textarea></div>
      <div class="field"><label for="f-userAppearance">Your appearance (optional)</label><textarea id="f-userAppearance" rows="2" placeholder="Used when you're in a picture">${v('userAppearance')}</textarea></div>
    </div>
    <div class="group">
      <h2>Situation</h2>
      ${library.pickerHtml('situations', picks.situations, pickLabel)}
      <div class="field"><label for="f-situation">Setting and what's going on (optional)</label><textarea id="f-situation" rows="3">${v('situation')}</textarea></div>
      ${opening ? `<div class="field"><label for="f-openingMessage">Opening message from the character (optional)</label><textarea id="f-openingMessage" rows="3">${v('openingMessage')}</textarea></div>` : ''}
    </div>
    <p class="hint">Tip: write {{char}} and {{user}} to stand in for the two names.</p>`;
}
// One extra character (group scenes) in the setup sheets.
function extraCharHtml(x, i) {
  const k = escapeHtml(x.key);
  const items = library.sorted('chars');
  const pick = items.length ? `<div class="field picker"><label for="xp-${k}">Choose from your library</label>
      <select id="xp-${k}" class="x-pick"><option value="">Write a new character</option>
      ${items.map((it) => `<option value="${it.id}"${it.id === x.charId ? ' selected' : ''}>${escapeHtml(it.name || 'Untitled')}</option>`).join('')}
      </select></div>` : '';
  return `<div class="extra-char" data-key="${k}">
      <div class="extra-head"><span class="extra-title">Character ${i + 2}</span>
        <button type="button" class="link-btn danger" data-remove-char>Remove</button></div>
      ${pick}
      <div class="field"><label for="xn-${k}">Name</label><input id="xn-${k}" class="x-name" type="text" value="${escapeHtml(x.name || '')}" autocomplete="off"></div>
      <div class="field"><label for="xd-${k}">Personality, background, how they talk</label>
        <textarea id="xd-${k}" class="x-desc" rows="5">${escapeHtml(x.description || '')}</textarea></div>
      <div class="field"><label for="xa-${k}">Appearance (optional)</label>
        <textarea id="xa-${k}" class="x-appear" rows="2" placeholder="Hair, build, age, usual clothes">${escapeHtml(x.appearance || '')}</textarea></div>
    </div>`;
}

// Hooks up "+ Add another character", Remove, and the library pickers for extra characters.
// state.extras: { [key]: { charId, photo } } for the blocks on screen.
function wireExtras(root, state) {
  const box = $('#extra-chars', root);
  const renumber = () => {
    const blocks = [...box.querySelectorAll('.extra-char')];
    blocks.forEach((b, i) => ($('.extra-title', b).textContent = `Character ${i + 2}`));
    $('#chars-heading', root).textContent = blocks.length ? 'AI characters' : 'AI character';
  };
  $('#add-char', root).addEventListener('click', () => {
    const x = { key: uid(), name: '', description: '' };
    state.extras[x.key] = { charId: '', photo: '' };
    box.insertAdjacentHTML('beforeend', extraCharHtml(x, box.children.length));
    renumber();
    const block = box.lastElementChild;
    ($('.x-pick', block) || $('.x-name', block)).focus();
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-char]');
    if (!b) return;
    const block = b.closest('.extra-char');
    delete state.extras[block.dataset.key];
    block.remove();
    renumber();
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('.x-pick');
    if (!sel) return;
    const block = sel.closest('.extra-char');
    const st = state.extras[block.dataset.key] || (state.extras[block.dataset.key] = {});
    const item = library.find('chars', sel.value);
    st.charId = item ? item.id : '';
    st.photo = item ? item.photo || '' : '';
    if (item) {
      $('.x-name', block).value = item.name || '';
      $('.x-desc', block).value = item.description || '';
      $('.x-appear', block).value = item.appearance || '';
    }
  });
}

// Reads the extra characters back from the sheet (blank ones are dropped).
function readExtras(root, state) {
  return [...root.querySelectorAll('.extra-char')].map((b) => {
    const st = state.extras[b.dataset.key] || {};
    return {
      key: b.dataset.key,
      charId: st.charId || '',
      photo: st.charId ? st.photo || '' : '',
      name: $('.x-name', b).value.trim(),
      description: $('.x-desc', b).value.trim(),
      appearance: $('.x-appear', b).value.trim(),
    };
  }).filter((x) => x.name);
}

// Saves extra characters to the library (or links to an identical saved one).
function linkExtrasToLibrary(chat, { update = false } = {}) {
  for (const x of chat.extraChars || []) {
    const item = library.find('chars', x.charId);
    if (item) {
      if (update) library.updateItem('chars', item.id, { name: x.name, description: x.description, appearance: x.appearance || '' });
      continue;
    }
    const same = library.sameAs('chars', { charName: x.name, charDescription: x.description, charAppearance: x.appearance });
    x.charId = (same || library.addItem('chars', { name: x.name, description: x.description, appearance: x.appearance || '', photo: '' })).id;
  }
}

const FIELD_KEYS = ['charName', 'charDescription', 'charAppearance', 'userName', 'userDescription', 'userAppearance', 'situation', 'openingMessage'];
const SETTINGS_FIELD_KEYS = ['charName', 'charDescription', 'charAppearance', 'userName', 'userDescription', 'userAppearance', 'situation', 'chatInstructions', 'narratorInstructions', 'useGlobal'];
function readFields(root, keys) {
  const out = {};
  for (const k of keys) {
    const el = $('#f-' + k, root);
    if (el) out[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// Hooks up the three library pickers in a sheet. state.picks[kind] = chosen library id
// ('' = none); state.photos = { charPhoto, userPhoto }.
// clearOnNone: choosing "Write a new one" empties the fields (New chat) or leaves them (Chat settings).
function wirePickers(root, state, { clearOnNone }) {
  for (const kind of Object.keys(KINDS)) {
    const sel = $('#p-' + kind, root);
    if (!sel) continue;
    sel.addEventListener('change', () => {
      const item = library.find(kind, sel.value);
      state.picks[kind] = sel.value;
      let fields = null;
      if (item) fields = library.toChat(kind, item);
      else if (clearOnNone) fields = Object.fromEntries(Object.values(MAP[kind].fields).map((k) => [k, '']));
      if (!fields) return;
      for (const [k, val] of Object.entries(fields)) {
        const el = $('#f-' + k, root);
        if (el) el.value = val;
        if (k === 'charPhoto' || k === 'userPhoto') state.photos[k] = val;
      }
    });
  }
}

// New chat: pick a character, you, and a situation (or write new ones), then start.
// pre: { chars, users, situations } library ids to start with.
function newChatSheet(pre = {}) {
  const picks = {
    chars: pre.chars || '',
    users: pre.users ?? (library.find('users', settings.lastUserCharId) ? settings.lastUserCharId : ''),
    situations: pre.situations || '',
  };
  const draft = { userName: 'User' };
  const photos = {};
  for (const kind of Object.keys(picks)) {
    const item = library.find(kind, picks[kind]);
    if (item) Object.assign(draft, library.toChat(kind, item));
    else picks[kind] = '';
  }
  photos.charPhoto = draft.charPhoto || '';
  photos.userPhoto = draft.userPhoto || '';
  const anyLib = Object.keys(KINDS).some((k) => lib[k].length);
  const s = openSheet({
    title: 'New chat',
    body:
      chatFields(draft, { picks }) +
      `<div class="toggle-row"><div><div class="label">Add new ones to my library</div><div class="hint">Characters or situations you write here get saved for next time.</div></div>
        <input type="checkbox" id="f-toLib" checked aria-label="Add new ones to my library"></div>
       <div class="toggle-row"><div><div class="label">Save this chat on my phone</div><div class="hint">Off = the chat disappears when you close the app.</div></div>
        <input type="checkbox" id="f-save" checked aria-label="Save this chat on my phone"></div>
       ${anyLib ? '' : '<p><button class="link-btn" id="fill-example">Fill in the example (Mara)</button></p>'}`,
    actions: '<button class="btn-primary" id="start-chat">Start chat</button>',
  });
  const state = { picks, photos, extras: {} };
  wirePickers(s.el, state, { clearOnNone: true });
  wireExtras(s.el, state);
  $('#fill-example', s.el)?.addEventListener('click', () => {
    for (const k of FIELD_KEYS) $('#f-' + k, s.el).value = EXAMPLE_CHAT[k];
  });
  $('#start-chat', s.el).addEventListener('click', () => {
    const f = readFields(s.el, FIELD_KEYS);
    if (!f.charName.trim()) { toast('Pick or write a character first.'); return; }
    if (!f.userName.trim()) f.userName = 'User';
    const chat = {
      v: 1,
      id: uid(),
      created: Date.now(),
      updated: Date.now(),
      ...f,
      charPhoto: state.picks.chars ? state.photos.charPhoto || '' : '',
      userPhoto: state.picks.users ? state.photos.userPhoto || '' : '',
      chatInstructions: '',
      narratorInstructions: '',
      useGlobal: true,
      save: $('#f-save', s.el).checked,
      auto: true,
      direction: '',
      extraChars: readExtras(s.el, state),
      messages: [],
    };
    // Remember which saved items this chat came from (its fields are its own copy).
    for (const kind of Object.keys(KINDS)) if (state.picks[kind]) chat[MAP[kind].id] = state.picks[kind];
    if ($('#f-toLib', s.el).checked) { linkToLibrary(chat); linkExtrasToLibrary(chat); }
    if ((chat.userCharId || '') !== (settings.lastUserCharId || '')) { settings.lastUserCharId = chat.userCharId || ''; saveSettings(); }
    if (f.openingMessage.trim()) {
      chat.messages.push(openingMessageFor(chat));
    }
    chats.set(chat.id, chat);
    saveChat(chat, { now: true });
    s.close();
    location.hash = '#/chat/' + chat.id;
  });
}

// The situation's opening line, as the first character's message.
function openingMessageFor(chat) {
  const text = fill((chat.openingMessage || '').trim(), chat, chat.charName);
  return { id: uid(), role: 'char', speaker: 'main', speakerName: chat.charName, versions: [text], vi: 0, ts: Date.now() };
}

// ---------- Chat screen ----------
function openChat(chat) {
  current = chat;
  $('#chat-name').textContent = chatTitle(chat);
  $('#chat-avatar').innerHTML = chatAvatarInner(chat);
  $('#chat-avatar').classList.toggle('stack', isGroup(chat));
  renderSpeakers();
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
  $('#view-chat').classList.remove('editing-mode');
  const box = $('#messages');
  const msgs = current.messages;
  if (!msgs.length) {
    box.innerHTML = `<p class="notice">Say something to ${escapeHtml(chatTitle(current))}, or tap Narrate to set the scene.<br>${isGroup(current) ? 'Tap a name under the direction box to choose who replies. ' : ''}Tip: tap any message to edit or delete it.</p>`;
  } else {
    let lastCharIndex = -1;
    msgs.forEach((m, i) => { if (m.role === 'char') lastCharIndex = i; });
    box.innerHTML = msgs.map((m, i) => messageHtml(m, i === lastCharIndex && i === msgs.length - 1)).join('');
  }
  const regen = lastMessage()?.role === 'char';
  const rb = $('#regenerate');
  rb.classList.toggle('reply-mode', !regen);
  rb.setAttribute('aria-label', regen ? 'Regenerate' : 'Reply');
  rb.title = regen ? 'Regenerate the last reply' : 'Reply';
  $('#picture').hidden = !picturesOn();
  $('#delete-last').disabled = !msgs.length;
}

function messageHtml(m, isLatestChar) {
  if (m.role === 'image') return pictureHtml(m);
  const streaming = gen && gen.msgId === m.id;
  const body = renderText(textOf(m));
  let swipes = '';
  if (m.role === 'char' && isLatestChar && m.versions.length > 1 && !streaming) {
    swipes = `<span class="swipes">
      <button data-swipe="-1" aria-label="Previous version"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <span>${m.vi + 1} / ${m.versions.length}</span>
      <button data-swipe="1" aria-label="Next version"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
    </span>`;
  }
  const tools = swipes ? `<div class="msg-tools">${swipes}</div>` : '';
  if (m.role === 'narrator') {
    return `<div class="msg narrator" data-id="${m.id}"><div class="narr-text${streaming ? ' typing' : ''}">${body}</div>${tools}</div>`;
  }
  return `<div class="msg ${m.role}" data-id="${m.id}">${m.role === 'char' && isGroup(current) ? speakerHtml(m, streaming) : ''}
    <div class="bubble${streaming ? ' typing' : ''}">${body}</div>${tools}</div>`;
}

// Name (and small photo) above a character's bubble in a group chat.
function speakerHtml(m, streaming) {
  const waiting = streaming && !m.speaker; // the model hasn't said who's speaking yet
  const who = speakerOf(current, m);
  const n = Math.max(0, castOf(current).findIndex((c) => c.key === who.key));
  return `<div class="speaker sp${n % 5}">${waiting ? '…' : `${avatarHtml(who.name, who.photo, 'xs')}<span>${escapeHtml(who.name)}</span>`}</div>`;
}

// Group chats: a row of names under the direction box. Tap one to have that character reply.
function renderSpeakers() {
  const row = $('#speakers');
  const cast = current && isGroup(current) ? castOf(current) : [];
  row.hidden = !cast.length;
  $('#speaker-chips').innerHTML = cast.map((c, i) =>
    `<button class="speaker-chip sp${i % 5}" data-speaker="${escapeHtml(c.key)}">${avatarHtml(c.name, c.photo, 'xs')}<span>${escapeHtml(c.name)}</span></button>`).join('');
}
$('#speaker-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-speaker]');
  if (!b || gen || !current) return;
  // Sends what's in the message box (if anything), then that character replies.
  const box = $('#message');
  const text = box.value.trim();
  if (text) {
    current.messages.push({ id: uid(), role: 'user', versions: [text], vi: 0, ts: Date.now() });
    box.value = '';
    saveChat(current);
    renderMessages();
    scrollToBottom(true);
  }
  generate('reply', { speaker: b.dataset.speaker });
});

function updateStreaming(m) {
  const el = $(`.msg[data-id="${m.id}"]`);
  if (!el) return renderMessages();
  if (m.role === 'char' && isGroup(current) && el.dataset.sp !== String(m.speaker || '')) {
    el.dataset.sp = String(m.speaker || '');
    const sp = $('.speaker', el);
    if (sp) sp.outerHTML = speakerHtml(m, true);
  }
  const target = m.role === 'narrator' ? $('.narr-text', el) : $('.bubble', el);
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

// Delete the last message (button in the action row), with Undo.
$('#delete-last').addEventListener('click', () => {
  if (gen || !current) return;
  const chat = current;
  const removed = chat.messages.pop();
  if (!removed) return;
  saveChat(chat);
  renderMessages();
  toast('Last message deleted.', 5000, {
    label: 'Undo',
    onClick: () => {
      chat.messages.push(removed);
      saveChat(chat);
      if (current === chat) { renderMessages(); scrollToBottom(true); }
    },
  });
});

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
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      if (wasTarget.classList.contains('image')) openViewer(wasTarget.dataset.id);
      else startInlineEdit(wasTarget.dataset.id);
      return;
    }
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
  if (m.role === 'image') return pictureMenu(m);
  const isLast = i === current.messages.length - 1;
  const s = openSheet({
    title: m.role === 'user' ? 'Your message' : m.role === 'narrator' ? 'Narration' : speakerOf(current, m).name + "'s message",
    body: `<ul class="menu">
      <li><button data-act="edit">Edit</button></li>
      <li><button data-act="copy">Copy text</button></li>
      ${m.role !== 'user' && isLast ? '<li><button data-act="regen">Regenerate</button></li>' : ''}
      ${picturesOn() ? '<li><button data-act="picture">Picture this moment</button></li>' : ''}
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
    if (act === 'picture') makePicture(i);
    if (act === 'delete') { current.messages.splice(i, 1); saveChat(current); renderMessages(); }
    if (act === 'delete-after') { current.messages.splice(i); saveChat(current); renderMessages(); }
  });
}

// Tap a message: edit it right where it is, or delete it.
// The message stays where it was on screen while the editor opens and closes,
// and the editor is kept in view when the keyboard comes up.
let editingId = null;

// Run `change` (which re-draws messages) without the message `id` moving on screen.
function keepInPlace(id, change) {
  const box = $('#messages');
  const top = () => {
    const el = id && $(`.msg[data-id="${id}"]`);
    return el ? el.getBoundingClientRect().top - box.getBoundingClientRect().top : null;
  };
  const before = top();
  change();
  const after = top();
  if (before !== null && after !== null) box.scrollTop += after - before;
}

// Editor height: fits its text, but never taller than the visible message area.
function sizeEditor() {
  const ta = $('#inline-text');
  if (!ta) return;
  const room = $('#messages').clientHeight - 24 - 44 - 8; // padding, buttons, gap
  ta.style.height = 'auto';
  ta.style.height = Math.max(96, Math.min(ta.scrollHeight + 4, room)) + 'px';
}

// Scroll just enough that the whole editor (text box and buttons) is visible.
function keepEditorVisible() {
  const box = $('#messages');
  const el = editingId && $(`.msg[data-id="${editingId}"]`);
  if (!el) return;
  sizeEditor();
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 8;
  if (r.top < b.top + pad || r.height > b.height - pad * 2) box.scrollTop += r.top - b.top - pad;
  else if (r.bottom > b.bottom - pad) box.scrollTop += r.bottom - b.bottom + pad;
}

function closeEditor(keepId) {
  if (!editingId) return;
  keepInPlace(keepId || editingId, () => renderMessages());
}

function startInlineEdit(id) {
  if (gen) return;
  if (editingId) closeEditor(id); // close any other open editor
  const m = current.messages.find((x) => x.id === id);
  if (!m || !$(`.msg[data-id="${id}"]`)) return;
  keepInPlace(id, () => {
    const el = $(`.msg[data-id="${id}"]`);
    editingId = id;
    el.classList.add('editing');
    $('#view-chat').classList.add('editing-mode'); // hide the bottom area to make room
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
    sizeEditor();
  });
  const ta = $('#inline-text');
  ta.addEventListener('input', () => { sizeEditor(); keepEditorVisible(); });
  ta.focus({ preventScroll: true });
  keepEditorVisible();
  // The keyboard slides up over ~0.3 s; check again once it has settled.
  setTimeout(keepEditorVisible, 350);
  setTimeout(keepEditorVisible, 700);
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
    const neighbor = current.messages[i] || current.messages[i - 1];
    editingId = null;
    keepInPlace(neighbor?.id, () => renderMessages());
    return;
  }
  closeEditor(id);
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
  gen.userStopped = true;
  gen.controller.abort();
  abortGeneration(apiSettings());
}

/**
 * mode: 'reply' | 'regenerate' | 'narrate' | 'renarrate' | 'writeForMe'
 */
// With pod control, the pod has to be ready before anything is generated.
function podNotReady() {
  if (podControlEnabled(settings) && !podState?.ready) {
    toast(podState ? 'The pod is still waking up. Try again in a moment.' : 'The pod is off. Tap Start in the banner above.');
    return true;
  }
  return false;
}

async function generate(mode, opts = {}) {
  if (gen || !current) return;
  if (podNotReady()) return;
  const chat = current;
  const msgs = chat.messages;
  let target = null;       // message being written into
  let history = msgs;
  let apiMode = mode;

  const group = isGroup(chat);
  if ((mode === 'regenerate' || mode === 'renarrate') && msgs[msgs.length - 1]?.role === 'image') mode = 'reply';
  if (mode === 'regenerate' || mode === 'renarrate') {
    target = msgs[msgs.length - 1];
    if (!target || target.role === 'user') return generate('reply');
    history = msgs.slice(0, -1);
    target.versions.push('');
    target.vi = target.versions.length - 1;
    apiMode = target.role === 'narrator' ? 'narrate' : 'reply';
    // Group chats: a new version comes from the same character.
    if (group && target.role === 'char' && castOf(chat).some((c) => c.key === (target.speaker || 'main'))) opts = { ...opts, speaker: target.speaker || 'main' };
  } else if (mode === 'reply' || mode === 'narrate') {
    target = { id: uid(), role: mode === 'narrate' ? 'narrator' : 'char', versions: [''], vi: 0, ts: Date.now() };
    if (target.role === 'char') {
      // One character: always them. Group: the one you picked, or (Send) whoever the model chooses.
      const pick = group ? opts.speaker : 'main';
      if (pick) { target.speaker = pick; target.speakerName = castOf(chat).find((c) => c.key === pick)?.name; }
    }
    msgs.push(target);
  }
  const groupReply = group && target?.role === 'char';
  const forced = !!(groupReply && opts.speaker);

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
    ({ text } = await streamChat(apiSettings(), messages, {
      signal: controller.signal,
      stop,
      onText: (t) => {
        // Group chats: read (and hide) the "**Name:**" the reply starts with.
        if (groupReply) {
          const sp = splitSpeaker(t, chat, { streaming: true });
          if (sp.key && !forced && target.speaker !== sp.key) { target.speaker = sp.key; target.speakerName = speakerOf(chat, target).name; }
          t = sp.text;
        }
        // Reply too long: stop as soon as an extra paragraph starts.
        if (maxP && paragraphs(t).length > maxP && !controller.signal.aborted) {
          controller.abort();
          abortGeneration(apiSettings());
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
    }));
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'aborted')) toast(e.message || 'Something went wrong.');
  }

  if (groupReply) {
    const sp = splitSpeaker(text, chat);
    if (sp.key && !forced) target.speaker = sp.key;
    if (!target.speaker) target.speaker = 'main';
    target.speakerName = speakerOf(chat, target).name;
    text = sp.text;
  }
  text = cutParagraphs(tidy(text, chat, apiMode), maxP);
  // Cut off by the length limit? End on the last complete sentence instead.
  // (If you pressed Stop yourself, the text is left exactly as it was.)
  if (!gen.userStopped) text = trimIncomplete(text);
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

// ---------- Pictures ----------
// Tap the picture button (or long-press a message → "Picture this moment"): the chat model
// describes the moment, then the image model on the pod draws it. Pictures are shown in the
// chat but never sent to the chat model.
const picturesOn = () => !!(settings.imageModelUrl || '').trim();

function pictureHtml(m) {
  const working = gen && gen.msgId === m.id;
  const id = (m.images || [])[m.ii ?? 0];
  const src = id && cachedImage(id);
  const w = Number(settings.imageWidth) || 832, h = Number(settings.imageHeight) || 1216;
  let inner;
  if (working && !id) inner = `<div class="pic-wait"><span class="spinner"></span>${gen.stage === 'image' ? 'Drawing…' : 'Imagining the scene…'}</div>`;
  else if (src) inner = `<img src="${src}" alt="Picture of the scene">`;
  else if (id) { inner = `<img data-img="${escapeHtml(id)}" alt="Picture of the scene">`; loadPicture(id); }
  else inner = '<div class="pic-wait">No picture</div>';
  const n = (m.images || []).length;
  const tools = n > 1 || (working && id)
    ? `<div class="msg-tools"><span class="swipes">
        <button data-pic-swipe="-1" aria-label="Previous picture"${working ? ' disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <span>${working ? 'Drawing…' : `${(m.ii ?? 0) + 1} / ${n}`}</span>
        <button data-pic-swipe="1" aria-label="Next picture"${working ? ' disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
      </span></div>` : '';
  return `<div class="msg image" data-id="${m.id}"><div class="pic-frame" style="aspect-ratio:${w}/${h}">${inner}</div>${tools}</div>`;
}

async function loadPicture(id) {
  const src = await getImage(id);
  for (const img of document.querySelectorAll(`img[data-img="${CSS.escape(id)}"]`)) {
    if (src) { img.src = src; img.removeAttribute('data-img'); } else img.replaceWith(Object.assign(document.createElement('div'), { className: 'pic-wait', textContent: 'Picture not found' }));
  }
}

// Draws one picture from a description and adds it to the message as a new version.
async function drawPicture(chat, m, signal) {
  const b64 = await txt2img(apiSettings(), {
    prompt: finalImagePrompt(m.prompt, settings.imageStyle),
    negative_prompt: settings.imageNegative || '',
    width: Number(settings.imageWidth) || 832,
    height: Number(settings.imageHeight) || 1216,
    steps: Number(settings.imageSteps) || 30,
    cfg_scale: Number(settings.imageCfg) || 5,
    sampler_name: settings.imageSampler || 'DPM++ 2M Karras',
    seed: -1,
    n_iter: 1,
    batch_size: 1,
  }, { signal });
  const jpeg = await toJpeg(b64);
  const id = uid();
  await putImage(id, jpeg, chat.save !== false);
  m.images = [...(m.images || []), id];
  m.ii = m.images.length - 1;
}

// index: the picture shows the story up to and including this message (default: the latest).
async function makePicture(index) {
  if (gen || !current) return;
  if (!picturesOn()) { toast('Pictures are off. Add an image model link in Settings → Pictures.'); return; }
  if (podNotReady()) return;
  const chat = current;
  const at = index ?? chat.messages.length - 1;
  const history = chat.messages.slice(0, at + 1).filter((m) => m.role !== 'image');
  if (!history.some((m) => textOf(m).trim())) { toast('Write a little of the story first.'); return; }
  const m = { id: uid(), role: 'image', versions: [''], vi: 0, images: [], ii: 0, prompt: '', ts: Date.now() };
  chat.messages.splice(at + 1, 0, m);
  const controller = new AbortController();
  gen = { controller, mode: 'picture', chatId: chat.id, msgId: m.id, stage: 'prompt' };
  setGenerating(true);
  const atEnd = at + 1 === chat.messages.length - 1;
  renderMessages();
  if (atEnd) scrollToBottom(true);
  try {
    // 1) The chat model describes the moment (assistant mode: steadier settings, short).
    const s = apiSettings();
    const { text } = await streamChat({ ...s, temperature: Math.min(Number(s.temperature) || 0.7, 0.7), xtcProbability: 0, dryMultiplier: 0, maxReplyTokens: 450 },
      buildImagePrompt(chat, settings, history, { lastPicture: [...chat.messages.slice(0, at + 1)].reverse().find((x) => x.role === 'image' && (x.scene || x.moment)) }),
      { signal: controller.signal });
    if (controller.signal.aborted) throw new ApiError('Stopped.', 'aborted');
    const parsed = parseImagePrompt(text);
    m.prompt = parsed.prompt;
    m.moment = parsed.moment;
    m.scene = parsed.scene;
    if (!m.prompt) throw new Error("The model didn't describe the scene. Try again.");
    // 2) The image model draws it.
    gen.stage = 'image';
    if (current === chat) renderMessages();
    await drawPicture(chat, m, controller.signal);
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'aborted')) toast(e.message || "Couldn't make the picture.", 6000);
  }
  if (!m.images.length) chat.messages.splice(chat.messages.indexOf(m), 1);
  gen = null;
  setGenerating(false);
  saveChat(chat);
  if (current === chat) { renderMessages(); if (atEnd) scrollToBottom(true); }
}

// Another version of a picture (same description, new random seed), or after editing the description.
async function redrawPicture(m) {
  if (gen || !current) return;
  if (podNotReady()) return;
  const chat = current;
  const controller = new AbortController();
  gen = { controller, mode: 'picture', chatId: chat.id, msgId: m.id, stage: 'image' };
  setGenerating(true);
  renderMessages();
  try {
    await drawPicture(chat, m, controller.signal);
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'aborted')) toast(e.message || "Couldn't make the picture.", 6000);
  }
  gen = null;
  setGenerating(false);
  saveChat(chat);
  if (current === chat) renderMessages();
}

function swipePicture(m, dir) {
  const n = (m.images || []).length;
  const next = (m.ii ?? 0) + dir;
  if (next >= n) { redrawPicture(m); return; }
  if (next < 0) return;
  m.ii = next;
  saveChat(current);
  renderMessages();
}
$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pic-swipe]');
  if (!b || gen) return;
  const m = current.messages.find((x) => x.id === b.closest('.msg').dataset.id);
  if (m) swipePicture(m, Number(b.dataset.picSwipe));
});

function deletePicture(m) {
  const chat = current;
  const i = chat.messages.indexOf(m);
  if (i < 0) return;
  chat.messages.splice(i, 1);
  saveChat(chat);
  renderMessages();
  toast('Picture deleted.', 5000, { label: 'Undo', onClick: () => { chat.messages.splice(i, 0, m); saveChat(chat); if (current === chat) renderMessages(); } });
}

async function savePicture(m) {
  const id = (m.images || [])[m.ii ?? 0];
  const src = id && (await getImage(id));
  if (!src) { toast("Couldn't find that picture."); return; }
  try {
    const r = await shareImage(src, `${chatTitle(current).replace(/[^\w -]+/g, '')} ${new Date(m.ts).toISOString().slice(0, 10)}.jpg`);
    if (r === 'downloaded') toast('Picture downloaded.');
  } catch { toast("Couldn't save the picture."); }
}

function editPictureSheet(m) {
  const s = openSheet({
    title: 'Picture description',
    body: `${m.scene ? `<p class="hint" style="margin:0 0 6px"><strong>The scene:</strong> ${escapeHtml(m.scene)}</p>` : ''}${m.moment ? `<p class="hint" style="margin:0 0 12px"><strong>The moment:</strong> ${escapeHtml(m.moment)}</p>` : ''}<div class="field"><label for="pic-prompt">What the picture shows</label>
        <textarea id="pic-prompt" rows="7">${escapeHtml(m.prompt || '')}</textarea>
        <p class="hint">Written by the model from the story. The image model pays most attention to the start, so put the main action first. The photo style from Settings → Pictures is added after it.</p></div>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="pic-redraw">Redraw</button>',
  });
  $('#pic-redraw', s.el).addEventListener('click', () => {
    const t = $('#pic-prompt', s.el).value.trim();
    if (!t) { toast('Describe the picture first.'); return; }
    m.prompt = t;
    s.close();
    redrawPicture(m);
  });
}

function pictureMenu(m) {
  const s = openSheet({
    title: 'Picture',
    body: `<ul class="menu">
      <li><button data-act="view">View</button></li>
      <li><button data-act="save">Save to Photos</button></li>
      <li><button data-act="again">New version</button></li>
      <li><button data-act="edit">Edit description and redraw</button></li>
      <li><button data-act="delete" class="danger">Delete picture</button></li>
    </ul>`,
  });
  s.el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    s.close();
    if (act === 'view') openViewer(m.id);
    if (act === 'save') savePicture(m);
    if (act === 'again') redrawPicture(m);
    if (act === 'edit') editPictureSheet(m);
    if (act === 'delete') deletePicture(m);
  });
}

// Full-screen view of a picture.
async function openViewer(id) {
  const m = current?.messages.find((x) => x.id === id);
  if (!m || m.role !== 'image') return;
  const imgId = (m.images || [])[m.ii ?? 0];
  const src = imgId && (await getImage(imgId));
  if (!src) return;
  const v = document.createElement('div');
  v.className = 'viewer';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-label', 'Picture');
  v.innerHTML = `<button class="viewer-close" data-v="close" aria-label="Close">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <img src="${src}" alt="Picture of the scene">
    <div class="viewer-bar">
      <button data-v="save">Save</button>
      <button data-v="again">New version</button>
      <button data-v="edit">Edit</button>
      <button data-v="delete" class="danger">Delete</button>
    </div>`;
  document.body.appendChild(v);
  v.addEventListener('click', (e) => {
    const act = e.target.closest('[data-v]')?.dataset.v;
    if (!act && e.target.tagName === 'IMG') return;
    v.remove();
    if (act === 'save') savePicture(m);
    if (act === 'again') redrawPicture(m);
    if (act === 'edit') editPictureSheet(m);
    if (act === 'delete') deletePicture(m);
  });
}

$('#picture').addEventListener('click', () => makePicture());

// ---------- Chat settings (⋯ or tap the name) ----------
function chatSettingsSheet() {
  const c = current;
  const picks = {};
  for (const kind of Object.keys(KINDS)) picks[kind] = library.find(kind, c[MAP[kind].id]) ? c[MAP[kind].id] : '';
  const state = { picks, photos: { charPhoto: c.charPhoto || '', userPhoto: c.userPhoto || '' }, extras: {} };
  for (const x of c.extraChars || []) state.extras[x.key] = { charId: x.charId || '', photo: x.photo || '' };
  const s = openSheet({
    title: 'Chat settings',
    body:
      chatFields(c, { picks, opening: false, pickLabel: 'Swap in from your library' }) +
      `<div class="toggle-row"><div><div class="label">Also save these changes to my library</div><div class="hint">Off = changes apply to this chat only.</div></div>
        <input type="checkbox" id="f-updateLib" aria-label="Also save these changes to my library"></div>
      <div class="group">
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
        <button class="btn-danger wide" id="clear-chat">Clear conversation</button>
        <p class="hint" style="margin:8px 0 14px">Deletes all messages and starts the story over${c.openingMessage?.trim() ? ' from the opening line' : ''}. Characters, situation and instructions stay.</p>
        <button class="btn-danger wide" id="delete-chat">Delete chat</button>
      </div>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="save-chat-settings">Save</button>',
  });
  wirePickers(s.el, state, { clearOnNone: false });
  wireExtras(s.el, state);

  $('#view-prompt', s.el).addEventListener('click', () => {
    const preview = { ...c, ...readFields(s.el, SETTINGS_FIELD_KEYS), extraChars: readExtras(s.el, state) };
    openSheet({ title: 'Full prompt', body: `<p class="hint">This is everything the model is told before the chat history. Nothing else is added except your "what happens next" direction.</p><pre class="prompt-view">${escapeHtml(systemPrompt(preview, settings))}</pre>` });
  });

  $('#delete-chat', s.el).addEventListener('click', () => {
    s.close();
    location.hash = '#/';
    deleteChat(c);
  });

  $('#clear-chat', s.el).addEventListener('click', () => {
    if (gen) { toast('Wait for the reply to finish (or tap Stop) first.'); return; }
    if (!confirm('Clear this conversation? All messages are deleted. Characters, situation and instructions stay.')) return;
    s.close();
    clearConversation(c);
  });

  $('#save-chat-settings', s.el).addEventListener('click', async () => {
    const f = readFields(s.el, [...SETTINGS_FIELD_KEYS, 'save']);
    if (!f.charName.trim()) { toast('The character needs a name.'); return; }
    const wasSaved = c.save !== false;
    Object.assign(c, f);
    c.extraChars = readExtras(s.el, state);
    // Swapped-in library items: link to them and use their photos.
    for (const kind of Object.keys(KINDS)) {
      if (state.picks[kind] && state.picks[kind] !== c[MAP[kind].id]) c[MAP[kind].id] = state.picks[kind];
    }
    c.charPhoto = state.photos.charPhoto || '';
    c.userPhoto = state.photos.userPhoto || '';
    if ($('#f-updateLib', s.el).checked) {
      for (const kind of Object.keys(KINDS)) {
        const id = c[MAP[kind].id];
        if (library.find(kind, id)) {
          const data = library.fromChat(kind, c);
          if (kind === 'situations') delete data.name; // keep its short name
          else if (!data.photo) delete data.photo;    // don't wipe a saved photo
          if (kind === 'situations') delete data.openingMessage;
          library.updateItem(kind, id, data);
        } else {
          linkToLibrary(c, [kind]);
        }
      }
      linkExtrasToLibrary(c, { update: true });
    }
    if (wasSaved && !c.save) await store.del('chat:' + c.id);
    if (!wasSaved && c.save) await persistImages(imageIdsOf(c));
    saveChat(c, { now: true });
    s.close();
    openChat(c);
  });
}
// Clear conversation: delete every message (and the direction), keep the setup. Undo restores it.
function clearConversation(chat) {
  const before = { messages: chat.messages, direction: chat.direction || '' };
  chat.messages = chat.openingMessage?.trim() ? [openingMessageFor(chat)] : [];
  chat.direction = '';
  saveChat(chat, { now: true });
  if (current === chat) openChat(chat);
  toast('Conversation cleared.', 8000, {
    label: 'Undo',
    onClick: () => {
      Object.assign(chat, before);
      saveChat(chat, { now: true });
      if (current === chat) openChat(chat);
      else if (!current) renderHome();
    },
  });
}

$('#chat-more').addEventListener('click', chatSettingsSheet);
$('#chat-title').addEventListener('click', chatSettingsSheet);
$('#chat-back').addEventListener('click', () => (location.hash = '#/'));

// ---------- App settings ----------
const NUM_FIELDS = [
  ['maxParagraphs', 'Max paragraphs per reply', 'Replies stop after this many. 0 = no limit.'],
  ['maxReplyTokens', 'Max reply length (tokens)', 'Safety net only. Too low and replies get cut off. 400 is a good value.'],
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
      <h2>Pod control (start/stop from the app)</h2>
      <div class="field"><label for="s-workerUrl">Worker address</label>
        <input id="s-workerUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://companion.yourname.workers.dev" value="${v('workerUrl')}">
        <p class="hint">Your Cloudflare Worker. It starts/stops the pod and runs the auto-off. See worker/SETUP.md.</p></div>
      <div class="field"><label for="s-appKey">App key</label>
        <input id="s-appKey" type="password" autocomplete="off" value="${v('appKey')}">
        <p class="hint">The APP_KEY you set in the Worker.</p></div>
      <div class="field"><label for="s-modelUrl">Model download link</label>
        <input id="s-modelUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" value="${v('modelUrl')}">
        <p class="hint">A .gguf link. Change this to try a different model.</p></div>
      <div class="field"><label for="s-lowBalanceWarning">Low-balance warning ($)</label>
        <input id="s-lowBalanceWarning" type="number" inputmode="decimal" step="any" min="0" value="${v('lowBalanceWarning')}">
        <p class="hint">Warns you when your Runpod balance drops below this, and before starting a pod. 0 = off.</p></div>
      <div class="row"><button class="btn-secondary" id="test-worker">Test Worker</button><span class="status" id="worker-status"></span></div>
    </div>
    <div class="group">
      <h2>Your pod</h2>
      <div class="field"><label for="s-password">Pod password</label>
        <input id="s-password" type="password" autocomplete="off" value="${v('password')}">
        <p class="hint">Any password. With pod control, every new pod is started with it.</p></div>
      <div class="field"><label for="s-podUrl">Pod address (only without pod control)</label>
        <input id="s-podUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://xxxxxxxx-5001.proxy.runpod.net" value="${v('podUrl')}">
        <p class="hint">With pod control this is filled in automatically.</p></div>
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
      <h2>Creator instructions</h2>
      <div class="field"><label for="s-creatorInstructions" class="sr-only">Creator instructions</label>
        <textarea id="s-creatorInstructions" rows="10">${v('creatorInstructions')}</textarea>
        <p class="hint">How the Creator (the ✦ Create screen) works with you. Your library's names are added after this.</p></div>
    </div>
    <div class="group">
      <h2>Pictures</h2>
      <div class="field"><label for="s-imageModelUrl">Image model link</label>
        <input id="s-imageModelUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Empty = pictures off" value="${v('imageModelUrl')}">
        <p class="hint">An SDXL .safetensors link, loaded on the pod next to the chat model (adds about 7GB and 1–2 minutes to start-up). Takes effect the next time you start the pod. Empty = pictures off.</p></div>
      <div class="field"><label for="s-imageStyle">Photo style (added to every picture)</label>
        <textarea id="s-imageStyle" rows="2">${v('imageStyle')}</textarea></div>
      <div class="field"><label for="s-imageNegative">Avoid in pictures</label>
        <textarea id="s-imageNegative" rows="3">${v('imageNegative')}</textarea></div>
      <div class="grid2">
        <div class="field"><label for="s-imageWidth">Width</label><input id="s-imageWidth" type="number" inputmode="numeric" step="64" value="${v('imageWidth')}"></div>
        <div class="field"><label for="s-imageHeight">Height</label><input id="s-imageHeight" type="number" inputmode="numeric" step="64" value="${v('imageHeight')}"></div>
        <div class="field"><label for="s-imageSteps">Steps</label><input id="s-imageSteps" type="number" inputmode="numeric" value="${v('imageSteps')}"><p class="hint">More = slower, a bit more detail.</p></div>
        <div class="field"><label for="s-imageCfg">Guidance (CFG)</label><input id="s-imageCfg" type="number" inputmode="decimal" step="any" value="${v('imageCfg')}"><p class="hint">How strictly it follows the description.</p></div>
      </div>
      <div class="field"><label for="s-imageSampler">Sampler</label>
        <input id="s-imageSampler" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${v('imageSampler')}"></div>
      <p class="hint">Portrait 832 × 1216 and landscape 1216 × 832 suit SDXL best.</p>
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
    </div>
    <div class="group">
      <h2>Backup</h2>
      <p class="hint" style="margin:0 0 10px">One file with your settings, characters and situations. Keep it somewhere safe, like iCloud Drive: iPhone can clear a web app's storage.</p>
      <div class="toggle-row"><div><div class="label">Include chats</div><div class="hint">Chats set to "don't save" are never included.</div></div>
        <input type="checkbox" id="b-chats" checked aria-label="Include chats"></div>
      <div class="toggle-row"><div><div class="label">Include pictures</div><div class="hint">Pictures in those chats. Makes the file much bigger (about 0.3MB each).</div></div>
        <input type="checkbox" id="b-pics" aria-label="Include pictures"></div>
      <div class="field" style="margin-top:12px"><label for="b-password">Password (optional)</label>
        <input id="b-password" type="password" autocomplete="new-password" placeholder="Leave empty for no password">
        <p class="hint">With a password, the file is encrypted and also keeps your pod address and password. Without one, those two are left out. There's no way to recover a forgotten password.</p></div>
      <div class="row"><button class="btn-primary" id="b-download">Download backup</button><button class="btn-secondary" id="b-restore">Restore from file</button></div>
    </div>
    <p class="hint" style="text-align:center;margin:24px 0">App version ${APP_VERSION}</p>`;

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
    const r = await testConnection(apiSettings());
    st.className = 'status ' + (r.ok ? 'ok' : 'bad');
    st.textContent = r.message;
  };
  $('#b-download').onclick = () => downloadBackup($('#b-chats').checked, $('#b-password').value, $('#b-pics').checked);
  $('#b-restore').onclick = () => $('#import-file').click();

  $('#test-worker').onclick = async () => {
    const st = $('#worker-status');
    if (!podControlEnabled(settings)) { st.className = 'status bad'; st.textContent = 'Fill in the Worker address and app key first.'; return; }
    st.className = 'status';
    st.textContent = 'Checking…';
    try {
      const r = await getStatus(settings);
      st.className = 'status ok';
      st.textContent = 'Connected to your Worker. Pod: ' + (r.pod ? r.pod.status.toLowerCase() : 'off') + '. ' +
        (r.account ? `Balance: $${r.account.balance.toFixed(2)}.` : "Balance: couldn't read it (update the Worker?).");
      applyAccount(r.account);
      applyPodStatus(r.pod);
    } catch (e) {
      st.className = 'status bad';
      st.textContent = e.message;
    }
  };
  $('#reset-settings').onclick = async () => {
    if (!confirm('Reset instructions, banned phrases and model settings to the defaults?')) return;
    settings = {
      ...DEFAULT_SETTINGS,
      podUrl: settings.podUrl, password: settings.password,
      workerUrl: settings.workerUrl, appKey: settings.appKey, modelUrl: settings.modelUrl,
    };
    await saveSettings();
    renderSettings();
    toast('Settings reset.');
  };
}
$('#settings-back').addEventListener('click', () => (location.hash = '#/'));

// ---------- Backup and restore ----------
async function downloadBackup(includeChats, password, includePictures = false) {
  const btn = $('#b-download');
  if (btn) btn.disabled = true;
  try {
    let data = buildBackup({
      settings,
      library: lib,
      chats: [...chats.values()],
      includeChats,
      includePod: !!password,
      appVersion: APP_VERSION,
    });
    if (includeChats && includePictures) {
      data.images = {};
      for (const c of data.chats) for (const id of imageIdsOf(c)) { const v = await getImage(id); if (v) data.images[id] = v; }
    }
    if (password) data = await encryptBackup(data, password);
    const date = new Date().toISOString().slice(0, 10);
    const r = await saveFile(JSON.stringify(data), `companion-backup-${date}.json`);
    if (r !== 'cancelled') toast(password ? 'Backup ready (password protected).' : 'Backup ready.');
  } catch (e) {
    toast("Couldn't make the backup: " + (e.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function restoreBackup(file) {
  if (!file.encrypted) return confirmRestore(file);
  const s = openSheet({
    title: 'Password-protected backup',
    body: `<div class="field"><label for="r-password">Backup password</label>
      <input id="r-password" type="password" autocomplete="current-password"></div>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="r-unlock">Unlock</button>',
  });
  setTimeout(() => $('#r-password', s.el).focus(), 50);
  $('#r-unlock', s.el).addEventListener('click', async () => {
    try {
      const data = await decryptBackup(file, $('#r-password', s.el).value);
      s.close();
      confirmRestore(data);
    } catch (e) {
      toast(e.message);
    }
  });
}

function confirmRestore(b) {
  const L = b.library || {};
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    count((L.chars || []).length, 'AI character', 'AI characters'),
    count((L.users || []).length, 'character for you', 'characters for you'),
    count((L.situations || []).length, 'situation', 'situations'),
    count((b.chats || []).length, 'chat', 'chats'),
  ];
  const nPics = Object.keys(b.images || {}).length;
  if (nPics) parts.push(count(nPics, 'picture', 'pictures'));
  const when = b.created ? new Date(b.created).toLocaleString() : 'an unknown date';
  const s = openSheet({
    title: 'Restore backup',
    body: `<p>Backup from ${escapeHtml(when)}:</p>
      <ul class="plain-list">${parts.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}<li>Settings and instructions</li></ul>
      <p class="hint">These are added to what's on this phone. Anything that's in both is replaced by the backup's version. Your current settings are replaced${b.settings && b.settings.podUrl ? '' : ', except your pod address and password, which stay as they are'}.</p>`,
    actions: '<button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" id="r-go">Restore</button>',
  });
  $('#r-go', s.el).addEventListener('click', async () => {
    try {
      if (b.settings && typeof b.settings === 'object') {
        const keep = { podUrl: settings.podUrl, password: settings.password };
        settings = { ...DEFAULT_SETTINGS, ...b.settings };
        if (!b.settings.podUrl) Object.assign(settings, keep);
        await saveSettings();
      }
      for (const kind of Object.keys(KINDS)) library.mergeItems(kind, L[kind]);
      await library.saveLibrary();
      for (const [id, v] of Object.entries(b.images || {})) {
        if (typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v)) await putImage(id, v, true);
      }
      for (const c of b.chats || []) {
        if (!c || !c.id || !Array.isArray(c.messages)) continue;
        c.save = true;
        chats.set(c.id, c);
        await store.set('chat:' + c.id, c);
      }
      s.close();
      toast('Backup restored.');
      if (location.hash === '#/settings') renderSettings();
      else route();
    } catch (e) {
      toast("Couldn't restore: " + (e.message || e));
    }
  });
}

library.initLibrary({ onStartChat: (charId) => { location.hash = '#/'; newChatSheet({ chars: charId }); } });
initCreator({
  getSettings: () => settings,
  apiSettings: () => apiSettings(),
  // Same rule as chats: with pod control, the pod has to be ready.
  readyMessage: () => (podControlEnabled(settings) && !podState?.ready
    ? (podState ? 'The pod is still waking up. Try again in a moment.' : 'The pod is off. Start it on the Chats screen.')
    : ''),
  startChat: (charId) => { location.hash = '#/'; newChatSheet({ chars: charId }); },
  back: () => (location.hash = prevHash === '#/library' ? '#/library' : '#/'),
});

// ---------- Pod control (start/stop, waking up, auto-off countdown) ----------
let podState = null;        // latest pod info from the Worker (null = off or unknown)
let podStatusAt = 0;        // when podState was fetched (ms)
let podBusy = false;        // a start/stop request is in flight
let podError = '';
let pollTimer = null;
let spend = {};
let account = null;         // { balance, spendPerHr, at } from the Worker (null = unknown)
let lowWarnedAt = null;     // balance we last warned about (warn once per drop)

// Runpod balance (from the Worker's status). Kept on the phone so it shows right away next time.
function applyAccount(a) {
  if (!a || typeof a.balance !== 'number') return;
  account = { balance: a.balance, spendPerHr: a.spendPerHr || 0, at: Date.now() };
  store.set('account', account).catch(() => {});
  const limit = Number(settings.lowBalanceWarning) || 0;
  if (limit > 0 && account.balance < limit) {
    if (lowWarnedAt === null) {
      lowWarnedAt = account.balance;
      toast(`Low Runpod balance: $${account.balance.toFixed(2)} left (${hoursLeftText()}). Add credit in Runpod.`, 7000);
    }
  } else {
    lowWarnedAt = null;
  }
}

// The GPU price to estimate with: the running pod's, else the last one seen, else an A40.
function hourlyRate() {
  return podState?.costPerHour || account?.spendPerHr || Number(spend.lastRate) || 0.59;
}
function hoursLeftText() {
  if (!account) return '';
  const h = account.balance / hourlyRate();
  return h < 1 ? `about ${Math.max(0, Math.round(h * 60))} min of chat` : `about ${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h of chat`;
}
const isLowBalance = () => {
  const limit = Number(settings.lowBalanceWarning) || 0;
  return !!account && limit > 0 && account.balance < limit;
};

// Settings for talking to KoboldCpp: with pod control, the pod address comes from the Worker.
function apiSettings() {
  if (podControlEnabled(settings) && podState?.url) return { ...settings, podUrl: podState.url };
  return settings;
}

function liveShutdownIn() {
  if (!podState) return null;
  return podState.shutdownInSec - (Date.now() - podStatusAt) / 1000;
}

function applyPodStatus(pod) {
  const wasReady = podState?.ready;
  podState = pod || null;
  podStatusAt = Date.now();
  podError = '';
  if (pod) {
    spend = recordSession(spend, pod);
    if (pod.costPerHour) spend.lastRate = pod.costPerHour;
    store.set('spend', spend).catch(() => {});
  }
  if (pod?.ready && !wasReady && podStatusAt - appStartedAt > 3000) toast('Your pod is ready.');
  renderPod();
}

async function refreshPod() {
  if (!podControlEnabled(settings) || document.hidden) return;
  try {
    const r = await getStatus(settings);
    applyAccount(r.account);
    applyPodStatus(r.pod);
  } catch (e) {
    podError = e.message;
    renderPod();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!podControlEnabled(settings)) return;
  // Poll often while waking up, less often once ready or off.
  const ms = podState && !podState.ready ? 8000 : podState ? 20000 : 45000;
  pollTimer = setTimeout(async () => { await refreshPod(); schedulePoll(); }, ms);
}

function renderPod() {
  const enabled = podControlEnabled(settings);
  const btn = $('#pod-btn');
  const dot = $('#pod-dot');
  const total = monthTotal(spend);
  const meta = $('#pod-meta');
  if (!enabled) meta.textContent = '';
  else {
    const low = isLowBalance();
    meta.classList.toggle('low', low);
    meta.innerHTML = (account
      ? `<span class="pod-balance">${low ? 'Low balance: ' : 'Balance: '}$${account.balance.toFixed(2)} · ${hoursLeftText()}</span>`
      : '') + `<span>This month: about $${total.toFixed(2)}</span>`;
  }

  if (!enabled) {
    dot.className = 'pod-dot';
    $('#pod-title').textContent = 'Pod control not set up';
    $('#pod-sub').innerHTML = 'Add your Worker in <a href="#/settings">Settings</a> to start and stop the pod from here.';
    btn.hidden = true;
  } else if (podBusy) {
    btn.disabled = true;
  } else if (!podState) {
    dot.className = 'pod-dot';
    $('#pod-title').textContent = 'Pod is off';
    $('#pod-sub').textContent = podError || 'Tap Start to load the model. Takes about 5–10 minutes.';
    btn.hidden = false; btn.disabled = false; btn.textContent = 'Start'; btn.className = 'pod-btn';
  } else if (!podState.ready) {
    dot.className = 'pod-dot waking';
    $('#pod-title').textContent = `Waking up… ${fmtDuration(podState.ageSec + (Date.now() - podStatusAt) / 1000)}`;
    $('#pod-sub').textContent = podError || `Downloading and loading the model on ${podState.gpu || 'the GPU'}. Usually 5–10 minutes.`;
    btn.hidden = false; btn.disabled = false; btn.textContent = 'Stop'; btn.className = 'pod-btn stop';
  } else {
    dot.className = 'pod-dot on';
    $('#pod-title').textContent = `Ready · ${(podState.gpu || 'GPU').replace(/^NVIDIA (GeForce |RTX )?/, '')} · $${podState.costPerHour.toFixed(2)}/hr`;
    const left = liveShutdownIn();
    $('#pod-sub').textContent = podError || `Auto-off in ${fmtDuration(left)}${podState.shutdownReason === 'idle' ? ' if no messages' : ''}`;
    btn.hidden = false; btn.disabled = false; btn.textContent = 'Stop'; btn.className = 'pod-btn stop';
  }
  renderChatBanner();
}

function renderChatBanner() {
  const enabled = podControlEnabled(settings);
  const left = liveShutdownIn();
  const showAutoOff = enabled && podState?.ready && left !== null && left <= 120;
  $('#autooff-banner').hidden = !showAutoOff;
  if (showAutoOff) $('#autooff-text').textContent = `Auto-off in ${fmtDuration(left)}`;
  const off = enabled && !podState?.ready;
  $('#pod-off-banner').hidden = !off;
  if (off) {
    $('#pod-off-text').textContent = podState ? `Pod is waking up… ${fmtDuration(podState.ageSec + (Date.now() - podStatusAt) / 1000)}` : 'The pod is off.';
    $('#banner-start').hidden = !!podState;
  }
}

async function podStart() {
  if (podBusy) return;
  if (!settings.password) { toast('Set a pod password in Settings first.'); location.hash = '#/settings'; return; }
  if (isLowBalance() && !confirm(`Your Runpod balance is $${account.balance.toFixed(2)} (${hoursLeftText()}). The pod stops when it runs out. Start anyway?`)) return;
  podBusy = true; renderPod();
  $('#pod-title').textContent = 'Starting…';
  $('#pod-sub').textContent = 'Asking Runpod for a GPU.';
  try {
    const r = await startPod(settings);
    applyPodStatus(r.pod);
    if (r.pod) toast(`Started on ${r.pod.gpu || 'a GPU'} at $${(r.pod.costPerHour || 0).toFixed(2)}/hr.`);
  } catch (e) {
    podError = e.message;
    toast(e.message, 6000);
  }
  podBusy = false; renderPod(); schedulePoll();
}

async function podStop() {
  if (podBusy) return;
  if (!confirm('Stop the pod? Billing stops right away. Your chats are kept on this phone.')) return;
  podBusy = true; renderPod();
  try {
    await stopPod(settings);
    applyPodStatus(null);
    toast('Pod stopped.');
  } catch (e) {
    toast(e.message, 6000);
  }
  podBusy = false; renderPod(); schedulePoll();
}

$('#pod-btn').addEventListener('click', () => (podState ? podStop() : podStart()));
$('#banner-start').addEventListener('click', podStart);
$('#keep-on').addEventListener('click', async () => {
  try {
    await keepAlive(podState.url, settings.password);
    await refreshPod();
    toast('Keeping it on.');
  } catch (_) {
    toast("Couldn't reach the pod.");
  }
});

// Tick the countdowns every second without asking the Worker.
setInterval(() => { if (podState) renderPod(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshPod(); schedulePoll(); } });
const appStartedAt = Date.now();

// ---------- Keyboard handling (iPhone) ----------
// Keep the app exactly as tall as the visible area, so the composer sits
// right above the keyboard and the latest messages stay in view.
function fitToViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', h + 'px');
  window.scrollTo(0, 0);
  // Keyboard is open when the visible area is much shorter than the screen.
  document.documentElement.classList.toggle('keyboard-open', h < window.innerHeight * 0.8 || (window.screen && h < screen.height * 0.7));
  if (keepSheetFieldVisible()) return;
  if (editingId) keepEditorVisible();
  else if (current) scrollToBottom();
  else if (!$('#view-creator').hidden) scrollCreatorToBottom();
}

// When typing inside a bottom sheet (e.g. the character editor), scroll the field
// into the visible part of the sheet once the keyboard has opened.
function keepSheetFieldVisible() {
  const el = document.activeElement;
  if (!el || !el.closest || !el.closest('.sheet-body') || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  return true;
}
document.addEventListener('focusin', (e) => {
  if (e.target.closest && e.target.closest('.sheet-body')) setTimeout(keepSheetFieldVisible, 350);
});
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
  spend = (await store.get('spend').catch(() => null)) || {};
  account = (await store.get('account').catch(() => null)) || null;
  // Remove pictures from deleted messages and chats (kept until now so Undo works).
  cleanupImages(new Set([...chats.values()].flatMap(imageIdsOf)));
  route();
  renderPod();
  await refreshPod();
  schedulePoll();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
