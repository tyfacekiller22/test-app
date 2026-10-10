// Talks to your Cloudflare Worker, which starts/stops the Runpod pod and runs the auto-off.
// The Runpod API key lives in the Worker, not on this phone.

export const podControlEnabled = (s) => !!(s.workerUrl?.trim() && s.appKey?.trim());

function base(s) {
  let u = s.workerUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

async function call(s, method, path, body) {
  let res;
  try {
    res = await fetch(base(s) + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-App-Key': s.appKey.trim() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    throw new Error("Can't reach your Worker. Check its address in Settings.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('The Worker rejected the app key. Check it in Settings.');
  if (!res.ok) throw new Error(data.error || `The Worker returned an error (${res.status}).`);
  return data;
}

export const getStatus = (s) => call(s, 'GET', '/status');
export const stopPod = (s) => call(s, 'POST', '/stop');
export const startPod = (s) =>
  call(s, 'POST', '/start', {
    modelUrl: s.modelUrl,
    password: s.password,
    contextSize: Number(s.contextSize) || 32768,
  });

// Resets the pod's idle timer by asking for a 1-token reply (costs nothing extra).
export async function keepAlive(podUrl, password) {
  await fetch(podUrl.replace(/\/+$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + password },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
  });
}

// ---------- Spending estimate (kept on this phone) ----------
// Each pod session is remembered by its id with its hourly price and how long it ran.
export function monthKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
export function recordSession(spend, pod) {
  if (!pod || !pod.id) return spend;
  const k = monthKey();
  const month = spend[k] || (spend[k] = {});
  const prev = month[pod.id] || { cost: pod.costPerHour, sec: 0 };
  month[pod.id] = { cost: pod.costPerHour || prev.cost, sec: Math.max(prev.sec, pod.ageSec || 0) };
  return spend;
}
export function monthTotal(spend) {
  const month = spend[monthKey()] || {};
  return Object.values(month).reduce((sum, s) => sum + (s.cost * s.sec) / 3600, 0);
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
