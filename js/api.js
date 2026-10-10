// Talks to KoboldCpp running on the Runpod pod.
// Uses KoboldCpp's OpenAI-style chat endpoint, which applies the model's own
// chat template, and passes KoboldCpp's extra samplers (DRY, XTC, banned phrases).

export class ApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'config' | 'auth' | 'network' | 'server' | 'aborted'
  }
}

function baseUrl(settings) {
  const url = (settings.podUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new ApiError('Add your pod address in Settings first.', 'config');
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

function headers(settings) {
  const h = { 'Content-Type': 'application/json' };
  if (settings.password) h.Authorization = 'Bearer ' + settings.password;
  return h;
}

export function samplerParams(settings) {
  const banned = (settings.bannedPhrases || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    max_tokens: Number(settings.maxReplyTokens),
    max_context_length: Number(settings.contextSize),
    temperature: Number(settings.temperature),
    min_p: Number(settings.minP),
    top_p: Number(settings.topP),
    top_k: Number(settings.topK),
    rep_pen: Number(settings.repPen),
    dry_multiplier: Number(settings.dryMultiplier),
    dry_base: Number(settings.dryBase),
    dry_allowed_length: Number(settings.dryAllowedLength),
    xtc_threshold: Number(settings.xtcThreshold),
    xtc_probability: Number(settings.xtcProbability),
    banned_tokens: banned,
  };
}

/**
 * Streams a reply. Calls onText(fullTextSoFar) as words arrive.
 * Returns the final text. Pass an AbortController's signal to stop early.
 */
export async function streamChat(settings, messages, { onText, signal, stop = [] } = {}) {
  const url = baseUrl(settings) + '/v1/chat/completions';
  const body = {
    messages,
    stream: true,
    stop,
    ...samplerParams(settings),
  };

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: headers(settings), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('Stopped.', 'aborted');
    throw new ApiError("Can't reach the pod. Is it running, and is the address in Settings right?", 'network');
  }
  if (res.status === 401) throw new ApiError('The pod rejected the password. Check it in Settings.', 'auth');
  if (!res.ok) throw new ApiError(`The pod returned an error (${res.status}).`, 'server');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null; // 'stop' = finished naturally, 'length' = hit the length limit
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
          const piece = json.choices?.[0]?.delta?.content;
          if (piece) {
            text += piece;
            onText?.(text);
          }
        } catch (_) { /* ignore partial or non-JSON lines */ }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return { text, finishReason: 'aborted' }; // keep whatever arrived before Stop
    throw new ApiError('The connection dropped mid-reply.', 'network');
  }
  return { text, finishReason };
}

// Tells the pod to stop generating (used together with aborting the request).
export async function abortGeneration(settings) {
  try {
    await fetch(baseUrl(settings) + '/api/extra/abort', {
      method: 'POST',
      headers: headers(settings),
      body: '{}',
    });
  } catch (_) { /* best effort */ }
}

// Checks the address and password. Returns { ok, message }.
export async function testConnection(settings) {
  let base;
  try { base = baseUrl(settings); } catch (e) { return { ok: false, message: e.message }; }
  try {
    const v = await fetch(base + '/api/extra/version').then((r) => r.json());
    const model = await fetch(base + '/api/v1/model').then((r) => r.json()).catch(() => ({}));
    // A tiny authenticated request to confirm the password.
    const t = await fetch(base + '/api/extra/tokencount', {
      method: 'POST',
      headers: headers(settings),
      body: JSON.stringify({ prompt: 'hi' }),
    });
    if (t.status === 401) return { ok: false, message: 'Pod found, but the password is wrong.' };
    const name = (model.result || '').replace(/^koboldcpp\//, '');
    const lock = v.protected ? 'password on' : 'WARNING: no password set on the pod';
    return { ok: true, message: `Connected: ${name || 'model loaded'} (KoboldCpp ${v.version}, ${lock}).` };
  } catch (_) {
    return { ok: false, message: "Can't reach the pod. Check it's running and the address is right." };
  }
}
