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

export function parseImport(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("That file isn't valid JSON.");
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
