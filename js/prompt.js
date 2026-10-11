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
// by short descriptions of how people look. The action comes first: image models pay
// the most attention to the start of the prompt.
// Shared part of the instructions; the Prompt format depends on the image model.
const IMAGE_STEPS = `You turn the current moment of a story into a prompt for a photorealistic image model. You are not continuing the story.

Work in two steps.
1. Scene: read the whole story you're given and work out where things stand now: the current location (it may have changed since the story began), who is present, where each person is and how they're positioned (sitting, standing, across a table, beside each other, lying down), what they're wearing now, and the time of day and lighting. When details conflict, the most recent ones win. If something was never said, make a sensible choice that fits.
2. Moment: from the most recent messages, decide what is happening right now: who is doing what, to or with whom. This is the subject of the picture, not a portrait of one person.`;

const IMAGE_RULES = `Rules:
- Refer to each person by a short description of their look (age, hair, a key feature or piece of clothing), never by name, because the image model doesn't know anyone.
- Use the Appearance notes so people look the same in every picture, adjusted for what they're wearing now.
- Include the user's character whenever they are part of the action or in the room. If their appearance isn't given, describe them plainly from what the story says.
- Show only what a camera would see at this exact moment. No dialogue, thoughts, sounds or backstory.`;

// For models that read full sentences (Z-Image, Flux): a short paragraph, action first.
const IMAGE_FORMAT_SENTENCES = `Reply in exactly this format:
Scene: one or two plain sentences: location, who is present, their positions, clothing, time of day.
Moment: one plain sentence saying what is happening right now.
Prompt: a paragraph of 3 to 5 plain sentences (60 to 120 words) describing the photo:
- Sentence 1 is the action, with everyone taking part in it and where they are relative to each other. Example: "A curly-haired woman in her late twenties, wearing a grey cardigan, leans across a small cafe table and hands a cup of coffee to a tall bearded man in a wet rain jacket sitting opposite her."
- Then their expressions and body language.
- Then the setting, the lighting and the time of day, as worked out in the Scene.
- Last, the camera framing (close-up, medium shot or wide shot) and angle.`;

// For models that read short phrases (SDXL): comma-separated phrases, action first.
const IMAGE_FORMAT_PHRASES = `Reply in exactly this format:
Scene: one or two plain sentences: location, who is present, their positions, clothing, time of day.
Moment: one plain sentence saying what is happening right now.
Prompt: 30 to 70 words of comma-separated phrases, in this order:
1. The action, with everyone taking part in it (4 to 8 words describing each person's look). Example: "a curly-haired woman in a grey cardigan handing a coffee to a tall bearded man in a rain jacket".
2. Their positions relative to each other, expressions and body language.
3. The setting, lighting and time of day, as worked out in the Scene.
4. The framing at the end: close-up, medium shot or wide shot (wide enough to show the action).`;

export function imageInstructions(type) {
  return [IMAGE_STEPS, type === 'sdxl' ? IMAGE_FORMAT_PHRASES : IMAGE_FORMAT_SENTENCES, IMAGE_RULES].join('\n\n');
}

// Story context for a picture: people, situation, the last picture's scene notes (if any),
// up to about 10,000 characters of earlier story, then the most recent messages, clearly marked.
export function buildImagePrompt(chat, settings, history, { focus = '', lastPicture = null, type = 'zimage' } = {}) {
  const cast = castOf(chat);
  const lines = [];
  lines.push('People in the story:');
  for (const c of cast) {
    const about = fill((c.description || '').trim(), chat, c.name).replace(/\s+/g, ' ').slice(0, 300);
    lines.push(`- ${c.name}. Appearance: ${(c.appearance || '').trim() || 'not given (infer from the description)'}. About: ${about || 'unknown'}`);
  }
  const userAbout = fill((chat.userDescription || '').trim(), chat).replace(/\s+/g, ' ').slice(0, 200);
  lines.push(`- ${chat.userName || 'User'} (the user's character). Appearance: ${(chat.userAppearance || '').trim() || 'not given'}.${userAbout ? ' About: ' + userAbout : ''}`);
  if (chat.situation?.trim()) lines.push('', 'How the story began (may be out of date): ' + fill(chat.situation.trim(), chat));

  const msgs = history.filter((m) => m.role !== 'image' && textOf(m).trim());
  const line = (m) => {
    const who = m.role === 'user' ? chat.userName || 'User' : m.role === 'narrator' ? 'Narrator' : speakerOf(chat, m).name;
    return `${who}: ${textOf(m).trim()}`;
  };
  const RECENT = 3;
  const recent = msgs.slice(-RECENT);
  const earlier = [];
  let size = 0;
  for (let i = msgs.length - RECENT - 1; i >= 0 && size < 10000; i--) {
    const l = line(msgs[i]);
    earlier.unshift(l);
    size += l.length;
  }
  if (lastPicture && (lastPicture.scene || lastPicture.moment)) {
    lines.push('', `Notes from the last picture in this story (may be out of date): ${[lastPicture.scene, lastPicture.moment].filter(Boolean).join(' ')}`);
  }
  if (earlier.length) lines.push('', 'Earlier in the story (use this to work out the Scene):', ...earlier);
  lines.push('', 'MOST RECENT MESSAGES (the moment to picture; these take priority):', ...recent.map(line));
  lines.push('', `Write the Scene, the Moment and the Prompt.${focus ? ' Focus on: ' + focus : ''}`);
  return [
    { role: 'system', content: imageInstructions(type) },
    { role: 'user', content: lines.join('\n') },
  ];
}

// Reads "Scene: …", "Moment: …" and "Prompt: …" from what the model wrote.
// Returns { scene, moment, prompt } with the prompt tidied into a single line.
export function parseImagePrompt(text, type = 'zimage') {
  const t = (text || '').replace(/\*\*/g, '');
  const pm = t.match(/(?:^|\n)\s*(?:image\s+)?prompt\s*:\s*([\s\S]*)$/i);
  const mm = t.match(/(?:^|\n)\s*moment\s*:\s*(.*)/i);
  const sm = t.match(/(?:^|\n)\s*scene\s*:\s*(.*)/i);
  const moment = mm ? mm[1].trim() : '';
  const scene = sm ? sm[1].trim() : '';
  let prompt = pm ? pm[1] : t.replace(/(?:^|\n)\s*(moment|scene)\s*:.*\n?/gi, '');
  prompt = prompt
    .replace(/^["“'`]+|["”'`]+$/g, '')
    .replace(/\*/g, '')
    .replace(/^\s*\d+\.\s*/gm, '')
    .replace(/\s*\n+\s*/g, type === 'sdxl' ? ', ' : ' ')
    .replace(/,\s*,/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
    .slice(0, 1000);
  return { scene, moment, prompt };
}

// What's sent to the image model: the description, then the photo style from Settings.
// SDXL only: the action (first phrase) gets a little extra weight.
export function finalImagePrompt(prompt, style, type = 'zimage') {
  let p = (prompt || '').trim();
  if (type !== 'sdxl') return [p && !/[.!?]$/.test(p) ? p + '.' : p, (style || '').trim()].filter(Boolean).join(' ');
  if (p && !/[()]/.test(p)) {
    const cut = p.indexOf(',');
    p = cut > 0 ? `(${p.slice(0, cut).trim()}:1.2)${p.slice(cut)}` : `(${p}:1.2)`;
  }
  return [p, (style || '').trim()].filter(Boolean).join(', ');
}
