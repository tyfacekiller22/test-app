// Builds what the model sees. Nothing is hidden: "View full prompt" in a chat's
// settings shows exactly this text.
//
// Order (later items override earlier ones):
//   global instructions → AI character(s) → user character → (group scene rules) → situation →
//   chat-specific instructions → chat history → active "what happens next" direction

// ---------- Cast (one or more AI characters) ----------
// The first character lives in the chat's own fields (charName, charDescription, charPhoto).
// Extra characters for group scenes live in chat.extraChars: [{ key, charId, name, description, photo }].
export function castOf(chat) {
  const main = { key: 'main', name: chat.charName || 'Character', description: chat.charDescription || '', appearance: chat.charAppearance || '', photo: chat.charPhoto || '', charId: chat.charId || '' };
  const extras = (chat.extraChars || []).filter((c) => c && (c.name || '').trim());
  return [main, ...extras];
}
export const isGroup = (chat) => castOf(chat).length > 1;

// "Mara", "Mara and Jo", "Mara, Jo and Lee"
export function joinNames(names) {
  if (names.length <= 2) return names.join(' and ');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
export const castNames = (chat) => joinNames(castOf(chat).map((c) => c.name));

// Who wrote a character message. Falls back to the name saved on the message
// (if that character was later removed), then to the first character.
export function speakerOf(chat, m) {
  const cast = castOf(chat);
  return cast.find((c) => c.key === (m.speaker || 'main')) ||
    (m.speakerName ? { key: m.speaker, name: m.speakerName, description: '', photo: '' } : cast[0]);
}

// {{char}} = the character (in a group: all of them, unless a name is given), {{user}} = you.
export function fill(text, chat, charName) {
  return (text || '')
    .replaceAll('{{char}}', charName || (isGroup(chat) ? castNames(chat) : chat.charName || 'Character'))
    .replaceAll('{{user}}', chat.userName || 'User');
}

// Reads a leading "**Name:**" / "Name:" label off a group reply.
// Returns { key, text } (key = null if no known name was found).
// While streaming, a label that's still arriving is hidden.
export function splitSpeaker(text, chat, { streaming = false } = {}) {
  const t = text || '';
  const m = t.match(/^\s*(?:\*\*)?\s*([^*\n:]{1,60}?)\s*(?:\*\*)?\s*:\s*(?:\*\*)?[ \t]*\n?/);
  if (m) {
    const name = m[1].trim().toLowerCase();
    const c = castOf(chat).find((x) => x.name.trim().toLowerCase() === name);
    if (c) return { key: c.key, text: t.slice(m[0].length) };
  }
  if (streaming && /^\s*(\*\*)?[^\n:*]{0,60}(\*\*)?\s*$/.test(t) && t.length < 64) return { key: null, text: '' };
  return { key: null, text: t };
}

export function systemPrompt(chat, settings) {
  const parts = [];
  const cast = castOf(chat);
  const group = cast.length > 1;
  if (chat.useGlobal !== false && settings.globalInstructions?.trim()) {
    parts.push(fill(settings.globalInstructions.trim(), chat));
  }
  const withLook = (text, look) => [text, look ? `Appearance: ${look}` : ''].filter(Boolean).join('\n');
  for (const c of cast) {
    const look = (c.appearance || '').trim();
    if (c.description.trim() || look) parts.push(`About ${c.name}\n${withLook(fill(c.description.trim(), chat, c.name), fill(look, chat, c.name))}`);
  }
  const userLook = (chat.userAppearance || '').trim();
  if (chat.userDescription?.trim() || userLook) {
    parts.push(`About ${chat.userName} (played by the user)\n${withLook(fill((chat.userDescription || '').trim(), chat), fill(userLook, chat))}`);
  }
  if (group) {
    const names = cast.map((c) => c.name);
    parts.push(
      `Group scene\nYou play all of these characters: ${joinNames(names)}. ${chat.userName || 'User'} is played by the user.\n` +
      `- Each reply is one character's turn. Start it with that character's name in bold and a colon, like **${names[0]}:**\n` +
      `- Keep each character's voice, knowledge, opinions and goals distinct. They can disagree, talk to each other and have their own reasons.\n` +
      `- Not everyone has to speak or be the focus. A character who isn't speaking doesn't need to be described.`
    );
  }
  if (chat.situation?.trim()) parts.push(`Situation\n${fill(chat.situation.trim(), chat)}`);
  if (chat.chatInstructions?.trim()) parts.push(`Instructions for this chat\n${fill(chat.chatInstructions.trim(), chat)}`);
  return parts.join('\n\n');
}

// Current text of a message (messages can have several regenerated versions).
export const textOf = (m) => m.versions[m.vi ?? 0] ?? '';

function historyAsMessages(chat, history) {
  const out = [];
  const group = isGroup(chat);
  for (const m of history) {
    const t = textOf(m).trim();
    if (!t) continue;
    let role, content;
    if (m.role === 'char') { role = 'assistant'; content = group ? `**${speakerOf(chat, m).name}:** ${t}` : t; }
    else if (m.role === 'narrator') { role = 'user'; content = `[Narrator: ${t}]`; }
    else { role = 'user'; content = t; }
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content; // the model expects turns to alternate
    else out.push({ role, content });
  }
  // The chat template expects the conversation to start with a user turn.
  if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: '[The scene begins.]' });
  return out;
}

// Rough token estimate (about 3.5 characters per token for English).
const estTokens = (s) => Math.ceil((s || '').length / 3.5);

function addUserNote(msgs, note) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') last.content += '\n\n' + note;
  else msgs.push({ role: 'user', content: note });
}

/**
 * mode: 'reply' | 'narrate' | 'writeForMe'
 * history: the messages before the one being generated.
 * Returns { messages, stop, trimmed } for the API.
 */
export function buildRequest(chat, settings, history, mode, { focus = '', speaker = null } = {}) {
  const cast = castOf(chat);
  const group = cast.length > 1;
  const who = group && speaker ? cast.find((c) => c.key === speaker) : null;
  const system = systemPrompt(chat, settings);
  let hist = historyAsMessages(chat, history);

  const notes = [];
  if (chat.direction?.trim() && mode !== 'writeForMe') {
    notes.push(
      `[Story direction from the user. Keep it in mind from now on and work it in naturally; don't quote it or treat it as dialogue: ${fill(chat.direction.trim(), chat)}]`
    );
  }
  if (mode === 'reply' && group) {
    notes.push(who
      ? `[Write only ${who.name}'s next reply. Start with **${who.name}:**]`
      : `[Write the next reply as whichever one of ${joinNames(cast.map((c) => c.name))} would most naturally speak now. Only one character. Start with their name, like **${cast[0].name}:**]`);
  }
  const maxP = Number(settings.maxParagraphs) || 0;
  if (mode === 'reply' && maxP > 0) {
    const whose = group ? (who ? `${who.name}'s` : 'the') : `${chat.charName}'s`;
    notes.push(`[Keep ${whose} reply to ${maxP === 1 ? 'one short paragraph' : `at most ${maxP} short paragraphs`}.]`);
  }
  if (mode === 'narrate') {
    const narr = (chat.narratorInstructions?.trim() || settings.narratorInstructions || '').trim();
    notes.push(
      fill(
        `[Narrator turn. Instead of {{char}}'s reply, write a short narration describing the current scene: the setting, the atmosphere, what {{char}} is doing and how {{char}} looks right now. Don't advance the plot. No dialogue. Don't describe {{user}}'s thoughts, feelings or actions. Output only the narration, without labels or brackets.${narr ? ' Style: ' + narr : ''}${focus ? ' Focus on: ' + focus : ''}]`,
        chat
      )
    );
  }
  if (mode === 'writeForMe') {
    notes.push(
      fill(
        "[Out of character: write {{user}}'s next message in this conversation, as {{user}} would say and do it, based on {{user}}'s description and the conversation so far. Write it the way the user writes: first person, dialogue in plain text, actions in *asterisks*. Keep it short. Output only the message itself, without labels.]",
        chat
      )
    );
  }

  // Keep within the model's memory: drop the oldest messages if needed.
  // (Stage 4 replaces this with automatic summaries.)
  const budget = Number(settings.contextSize) - Number(settings.maxReplyTokens) - 200;
  const fixed = estTokens(system) + estTokens(notes.join('\n'));
  let trimmed = 0;
  while (hist.length > 1 && fixed + hist.reduce((n, m) => n + estTokens(m.content), 0) > budget) {
    hist.shift();
    trimmed++;
  }
  if (hist.length && hist[0].role === 'assistant') hist.unshift({ role: 'user', content: '[Earlier conversation omitted.]' });

  const messages = [{ role: 'system', content: system }, ...hist];
  for (const n of notes) addUserNote(messages, n);
  if (messages[messages.length - 1].role !== 'user') addUserNote(messages, '[Continue.]');

  // Stop when the model starts writing someone else's turn.
  let stop;
  if (mode === 'writeForMe') stop = cast.flatMap((c) => [`\n${c.name}:`, `\n**${c.name}:**`]);
  else {
    stop = [`\n${chat.userName}:`, `\n**${chat.userName}:**`];
    if (group && mode === 'reply') stop.push(...cast.map((c) => `\n**${c.name}:**`), ...cast.map((c) => `\n${c.name}:`));
  }
  return { messages, stop: stop.slice(0, 16), trimmed };
}

// Splits a reply into paragraphs. Uses blank lines if the model uses them,
// otherwise single line breaks.
export function paragraphs(text) {
  const t = (text || '').trim();
  if (!t) return [];
  return (/\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split(/\n/)).filter((p) => p.trim());
}
export function cutParagraphs(text, max) {
  if (!max || max <= 0) return text;
  const ps = paragraphs(text);
  if (ps.length <= max) return text;
  const sep = /\n\s*\n/.test(text) ? '\n\n' : '\n';
  return ps.slice(0, max).join(sep);
}

// If a reply was cut off mid-sentence, trim it back to the last complete sentence
// and close any *action* left open.
const ENDS_CLEAN = /[.!?…"”'’*)~\]]\s*$/;
export function trimIncomplete(text) {
  let t = (text || '').trimEnd();
  if (!t || ENDS_CLEAN.test(t)) return t;
  // Last sentence end: . ! ? … optionally followed by closing quotes/asterisks/brackets.
  const re = /[.!?…]["”'’*)\]]*(?=\s|$)/g;
  let cut = -1, m;
  while ((m = re.exec(t))) cut = m.index + m[0].length;
  if (cut > t.length * 0.3) t = t.slice(0, cut).trimEnd(); // don't throw away most of a reply
  else t = t.replace(/[\s,;:–—-]+$/, '') + '…';             // no clean place to cut: trail off
  // Close an unfinished *action*.
  if (((t.match(/\*/g) || []).length) % 2 === 1) t += '*';
  return t;
}

// Cleans up a finished reply: removes a leading "Name:" label and stray whitespace.
export function tidy(text, chat, mode) {
  let t = (text || '').trim();
  const label = mode === 'writeForMe' ? chat.userName : mode === 'narrate' ? 'Narrator' : chat.charName;
  const re = new RegExp(`^(\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\*\\*)?\\s*`, 'i');
  t = t.replace(re, '');
  if (mode === 'narrate') t = t.replace(/^\[|\]$/g, '').trim();
  return t;
}

// ---------- Pictures ----------
// The chat model (in assistant mode) turns the current moment into a description an
// image model can draw. Image models don't know who anyone is, so names are replaced
// by what people look like.
export const IMAGE_PROMPT_INSTRUCTIONS = `You turn a moment from a story into a prompt for a photorealistic image model. You are not continuing the story.

Write one paragraph of comma-separated descriptive phrases, 40 to 80 words:
- Start with the framing (close-up, medium shot or wide shot) and who is in the frame.
- Describe each visible person by how they look, never by name: the image model doesn't know who anyone is. Use their Appearance notes closely so they look the same in every picture. Add their expression, pose and what they're doing right now.
- Then clothing, the setting, lighting and time of day.
- Only what a camera would see at this exact moment. No dialogue, thoughts, sounds, backstory or story events that already ended.
- Include the user's character only if they'd naturally be in view. If their appearance isn't given, frame the shot from their point of view instead.
Output only the prompt, with no label or quotes.`;

export function buildImagePrompt(chat, settings, history, { focus = '' } = {}) {
  const cast = castOf(chat);
  const lines = [];
  lines.push('People in the story:');
  for (const c of cast) {
    const about = fill((c.description || '').trim(), chat, c.name).replace(/\s+/g, ' ').slice(0, 300);
    lines.push(`- ${c.name}. Appearance: ${(c.appearance || '').trim() || 'not given (infer from the description)'}. About: ${about || 'unknown'}`);
  }
  const userAbout = fill((chat.userDescription || '').trim(), chat).replace(/\s+/g, ' ').slice(0, 200);
  lines.push(`- ${chat.userName || 'User'} (the user's character). Appearance: ${(chat.userAppearance || '').trim() || 'not given'}.${userAbout ? ' About: ' + userAbout : ''}`);
  if (chat.situation?.trim()) lines.push('', 'Situation: ' + fill(chat.situation.trim(), chat));

  // The last part of the story, newest last (about 6,000 characters).
  const recent = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0 && size < 6000; i--) {
    const m = history[i];
    const t = textOf(m).trim();
    if (!t || m.role === 'image') continue;
    const who = m.role === 'user' ? chat.userName || 'User' : m.role === 'narrator' ? 'Narrator' : speakerOf(chat, m).name;
    recent.unshift(`${who}: ${t}`);
    size += t.length;
  }
  lines.push('', 'The story so far (latest last):', ...recent);
  lines.push('', `Write the image prompt for the moment at the very end of the story.${focus ? ' Focus on: ' + focus : ''}`);
  return [
    { role: 'system', content: IMAGE_PROMPT_INSTRUCTIONS },
    { role: 'user', content: lines.join('\n') },
  ];
}

// Tidies what the model wrote into a single-line prompt.
export function cleanImagePrompt(text) {
  return (text || '')
    .replace(/^\s*(image )?prompt\s*:\s*/i, '')
    .replace(/^["“'`]+|["”'`]+$/g, '')
    .replace(/\*/g, '')
    .replace(/\s*\n+\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .trim()
    .slice(0, 1000);
}
