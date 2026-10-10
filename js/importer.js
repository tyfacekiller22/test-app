// Imports chats and characters from other apps' .json files.
//
// Supported:
//  - Perchance "AI Character Chat" exports/backups (characters, threads, messages),
//    including the full-backup format (a Dexie database export) and single-character files.
//  - SillyTavern / Character Card JSON (V1, V2, V3): imported as a character with its opening message.
//
// Returns a list of "drafts". Each draft becomes one chat in this app.
// Nothing is sent anywhere: the file is read on this device only.

const str = (v) => (typeof v === 'string' ? v : '');

// Find table rows in the many shapes an export can take.
function findTables(json) {
  const tables = {};
  const add = (name, rows) => {
    if (Array.isArray(rows)) tables[name] = (tables[name] || []).concat(rows);
  };
  // Dexie export: { formatName: 'dexie', data: { data: [ { tableName, rows } ] } }
  const dexie = json?.data?.data;
  if (Array.isArray(dexie)) for (const t of dexie) add(t.tableName, t.rows);
  // Plain object of arrays: { characters: [...], threads: [...], messages: [...] }
  for (const key of ['characters', 'threads', 'messages']) add(key, json?.[key]);
  // Share-link style single character
  if (json?.addCharacter) add('characters', [json.addCharacter]);
  if (json?.character && typeof json.character === 'object') add('characters', [json.character]);
  return tables;
}

function messageText(m) {
  return str(m.message) || str(m.content) || str(m.text) || str(m.mes);
}

// Perchance marks who wrote a message by characterId: -1 = the user, -2 = system/narrator.
function roleOf(m, mainCharId) {
  const author = m.author ?? m.role;
  if (author === 'user' || m.characterId === -1 || m.is_user === true) return 'user';
  if (author === 'system' || m.characterId === -2) return 'narrator';
  return 'char';
}

function perchanceCharacterFields(c, userChar) {
  const reminder = str(c?.reminderMessage).trim();
  return {
    charName: str(c?.name).trim() || 'Character',
    charDescription: str(c?.roleInstruction).trim(),
    userName: str(userChar?.name).trim() || str(c?.userCharacter?.name).trim() || 'User',
    userDescription: str(userChar?.roleInstruction).trim() || str(c?.userCharacter?.roleInstruction).trim(),
    situation: '',
    chatInstructions: reminder,
  };
}

function initialMessages(c) {
  const list = Array.isArray(c?.initialMessages) ? c.initialMessages : [];
  return list
    .map((m) => ({ role: roleOf(m), text: messageText(m) }))
    .filter((m) => m.text.trim());
}

function fromPerchance(tables) {
  const characters = tables.characters || [];
  const threads = tables.threads || [];
  const messages = tables.messages || [];
  const byId = new Map(characters.map((c) => [c.id, c]));
  const drafts = [];
  const charsWithThreads = new Set();

  for (const t of threads) {
    const c = byId.get(t.characterId) || {};
    charsWithThreads.add(t.characterId);
    const msgs = messages
      .filter((m) => m.threadId === t.id)
      .filter((m) => !(Array.isArray(m.hiddenFrom) && m.hiddenFrom.includes('user')))
      .sort((a, b) => (a.order ?? a.creationTime ?? a.id ?? 0) - (b.order ?? b.creationTime ?? b.id ?? 0))
      .map((m) => {
        const role = roleOf(m, t.characterId);
        let text = messageText(m);
        // In group chats, keep other characters' names visible.
        if (role === 'char' && m.characterId !== t.characterId && byId.get(m.characterId)?.name) {
          text = `**${byId.get(m.characterId).name}:** ${text}`;
        }
        const versions = Array.isArray(m.variants)
          ? m.variants.map((v) => (typeof v === 'string' ? v : messageText(v || {}))).filter(Boolean)
          : [];
        return { role, text, versions };
      })
      .filter((m) => m.text.trim());
    drafts.push({
      title: str(t.name) || str(c.name) || 'Imported chat',
      ...perchanceCharacterFields(c, t.userCharacter),
      messages: msgs.length ? msgs : initialMessages(c),
    });
  }
  // Characters without any chat: import them with their opening messages.
  for (const c of characters) {
    if (charsWithThreads.has(c.id)) continue;
    drafts.push({ title: str(c.name) || 'Character', ...perchanceCharacterFields(c), messages: initialMessages(c) });
  }
  return drafts;
}

function fromCharacterCard(json) {
  const d = json?.data && typeof json.data === 'object' && !Array.isArray(json.data) && json.data.name ? json.data : json;
  if (!d?.name || !(d.description || d.personality || d.first_mes || d.scenario)) return [];
  const desc = [str(d.description), d.personality ? 'Personality: ' + str(d.personality) : '', d.mes_example ? 'Example dialogue:\n' + str(d.mes_example) : '']
    .filter((s) => s.trim())
    .join('\n\n');
  const first = str(d.first_mes).trim();
  return [{
    title: d.name,
    charName: d.name,
    charDescription: desc,
    userName: 'User',
    userDescription: '',
    situation: str(d.scenario),
    chatInstructions: str(d.system_prompt || d.post_history_instructions || ''),
    messages: first ? [{ role: 'char', text: first, versions: [] }] : [],
  }];
}

// perchance.org/ai-chat saves one chat per file:
// { format: 'perchance-ai-chat-v1', botName, userName, botDescription, userDescription,
//   scenario, chatLogs (the whole conversation as text), whatHappensNext, writingInstructions }
// chatLogs is split into messages at lines that start with a speaker name, e.g.
// "[Mary]: Hi" or "Mary: Hi". Anything else stays part of the message above it.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function splitChatLog(log, botName, userName, otherNames = []) {
  const text = str(log).replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const names = [botName, userName, 'Narrator', 'System', 'SYSTEM', ...otherNames].filter(Boolean);
  const nameAlt = names.map(escapeRe).join('|');
  // Speaker line: optional ** or [ ], the name, optional ] or **, then a colon.
  const speaker = new RegExp(`^\\s*(?:\\*\\*)?\\[?(${nameAlt})\\]?(?:\\*\\*)?\\s*:\\s?(.*)$`, 'i');
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(speaker);
    if (m) {
      if (cur) out.push(cur);
      const who = m[1].toLowerCase();
      const role = who === str(userName).toLowerCase() ? 'user' : who === str(botName).toLowerCase() ? 'char' : 'narrator';
      cur = { role, name: m[1], lines: [m[2]] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { role: 'narrator', name: '', lines: [line] }; // text before the first speaker
    }
  }
  if (cur) out.push(cur);
  return out
    .map((m) => {
      let t = m.lines.join('\n').trim();
      // Another character in the scene (not the main bot): keep their name visible.
      if (m.role === 'narrator' && m.name && !/^(narrator|system)$/i.test(m.name)) {
        return { role: 'char', text: `**${m.name}:** ${t}`, versions: [] };
      }
      return { role: m.role, text: t, versions: [] };
    })
    .filter((m) => m.text);
}

function fromPerchanceAiChat(json) {
  const botName = str(json.botName).trim() || 'Character';
  const userName = str(json.userName).trim() || 'User';
  const others = Array.isArray(json.miscData?.deletedCharacterNames) ? json.miscData.deletedCharacterNames.filter((n) => typeof n === 'string') : [];
  const messages = splitChatLog(json.chatLogs, botName, userName, others);
  return [{
    title: `${botName} & ${userName}`,
    charName: botName,
    charDescription: str(json.botDescription).trim(),
    userName,
    userDescription: str(json.userDescription).trim(),
    situation: str(json.scenario).trim(),
    chatInstructions: str(json.writingInstructions).trim(),
    direction: str(json.whatHappensNext).trim(),
    messages,
  }];
}

export function parseImport(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("That file isn't valid JSON.");
  }
  if (str(json?.format).startsWith('perchance-ai-chat') || ('chatLogs' in (json || {}) && 'botName' in (json || {}))) {
    return { source: 'Perchance AI Chat', drafts: fromPerchanceAiChat(json) };
  }
  const tables = findTables(json);
  if ((tables.characters?.length || 0) + (tables.threads?.length || 0) > 0) {
    const drafts = fromPerchance(tables);
    if (drafts.length) return { source: 'Perchance', drafts };
  }
  const card = fromCharacterCard(json);
  if (card.length) return { source: 'character card', drafts: card };
  throw new Error("Couldn't find any characters or chats in that file.");
}
