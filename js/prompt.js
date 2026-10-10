// Builds what the model sees. Nothing is hidden: "View full prompt" in a chat's
// settings shows exactly this text.
//
// Order (later items override earlier ones):
//   global instructions → AI character → user character → situation →
//   chat-specific instructions → chat history → active "what happens next" direction

export function fill(text, chat) {
  return (text || '')
    .replaceAll('{{char}}', chat.charName || 'Character')
    .replaceAll('{{user}}', chat.userName || 'User');
}

export function systemPrompt(chat, settings) {
  const parts = [];
  if (chat.useGlobal !== false && settings.globalInstructions?.trim()) {
    parts.push(settings.globalInstructions.trim());
  }
  if (chat.charDescription?.trim()) {
    parts.push(`About ${chat.charName}\n${chat.charDescription.trim()}`);
  }
  if (chat.userDescription?.trim()) {
    parts.push(`About ${chat.userName} (played by the user)\n${chat.userDescription.trim()}`);
  }
  if (chat.situation?.trim()) parts.push(`Situation\n${chat.situation.trim()}`);
  if (chat.chatInstructions?.trim()) parts.push(`Instructions for this chat\n${chat.chatInstructions.trim()}`);
  return fill(parts.join('\n\n'), chat);
}

// Current text of a message (messages can have several regenerated versions).
export const textOf = (m) => m.versions[m.vi ?? 0] ?? '';

function historyAsMessages(chat, history) {
  const out = [];
  for (const m of history) {
    const t = textOf(m).trim();
    if (!t) continue;
    let role, content;
    if (m.role === 'char') { role = 'assistant'; content = t; }
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
export function buildRequest(chat, settings, history, mode, { focus = '' } = {}) {
  const system = systemPrompt(chat, settings);
  let hist = historyAsMessages(chat, history);

  const notes = [];
  if (chat.direction?.trim() && mode !== 'writeForMe') {
    notes.push(
      `[Story direction from the user. Keep it in mind from now on and work it in naturally; don't quote it or treat it as dialogue: ${fill(chat.direction.trim(), chat)}]`
    );
  }
  const maxP = Number(settings.maxParagraphs) || 0;
  if (mode === 'reply' && maxP > 0) {
    notes.push(fill(`[Keep {{char}}'s reply to ${maxP === 1 ? 'one short paragraph' : `at most ${maxP} short paragraphs`}.]`, chat));
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

  const name = mode === 'writeForMe' ? chat.charName : chat.userName;
  const stop = [`\n${name}:`, `\n**${name}:**`];
  return { messages, stop, trimmed };
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
