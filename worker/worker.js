// Companion pod controller: a Cloudflare Worker (free plan is enough).
//
// What it does:
//  1. Starts and stops your chat pod on Runpod when the app asks (it holds your Runpod API key,
//     so the key never has to live on your phone).
//  2. Auto-off: every minute it checks the pod and shuts it down after IDLE_MINUTES without
//     messages, after MAX_HOURS no matter what, or if the model never finished loading.
//     This runs in the cloud, so it works even when your phone is locked or the app is closed.
//
// Settings (Cloudflare → your Worker → Settings → Variables and Secrets):
//   RUNPOD_API_KEY  (secret)  your Runpod API key
//   APP_KEY         (secret)  any long random password; paste the same one into the app's Settings
//   ALLOWED_ORIGIN  (text)    your app's address, e.g. https://tyfacekiller22.github.io
//   IDLE_MINUTES    (text, optional, default 15)
//   MAX_HOURS       (text, optional, default 3)
//   LOAD_TIMEOUT_MINUTES (text, optional, default 30): give up if the model hasn't loaded by then
// Trigger (Settings → Triggers → Cron Triggers): * * * * *   (every minute)

const API = 'https://api.runpod.io/v2';
const POD_NAME = 'companion-chat';
const IMAGE = 'ghcr.io/lostruins/koboldcpp';
// Tried in order until one is available. All have 48GB, enough for a 31B model at Q6/Q8.
const DEFAULT_GPUS = ['NVIDIA A40', 'NVIDIA RTX A6000', 'NVIDIA L40', 'NVIDIA L40S', 'NVIDIA RTX 6000 Ada Generation'];

const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));

function config(env) {
  return {
    idleSec: num(env.IDLE_MINUTES, 15) * 60,
    maxSec: num(env.MAX_HOURS, 3) * 3600,
    loadTimeoutSec: num(env.LOAD_TIMEOUT_MINUTES, 30) * 60,
  };
}

// ---------- Runpod API ----------
async function runpod(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.RUNPOD_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { detail: text }; }
  return { status: res.status, ok: res.ok, data };
}

function asList(data) {
  if (Array.isArray(data)) return data;
  return data?.pods || data?.data || data?.items || [];
}

async function ourPods(env) {
  const r = await runpod(env, 'GET', '/pods');
  if (!r.ok) throw new Error(`Runpod: couldn't list pods (${r.status}) ${r.data?.detail || r.data?.title || ''}`);
  return asList(r.data).filter((p) => (p.name || '').startsWith(POD_NAME) && !['TERMINATED'].includes(p.status));
}

// The pod's web address for port 5001 (Runpod's HTTPS proxy).
export function podUrl(id) {
  return `https://${String(id).replace(/^pod_/, '')}-5001.proxy.runpod.net`;
}

// Asks KoboldCpp on the pod how long it has been idle. Returns null while the model is still loading.
async function perf(id) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(podUrl(id) + '/api/extra/perf', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.idletime === 'number' ? j : null;
  } catch (_) {
    return null;
  }
}

function secondsSince(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? null : (Date.now() - t) / 1000;
}

// Everything the app needs to show, plus the auto-off decision.
async function describe(env, pod) {
  const cfg = config(env);
  const running = pod.status === 'RUNNING';
  const age = pod.runtime?.uptime ?? secondsSince(pod.startedAt || pod.createdAt) ?? 0;
  const p = running ? await perf(pod.id) : null;
  const ready = !!p;
  let shutdownIn = Math.max(0, cfg.maxSec - age);
  let reason = 'time limit';
  if (ready) {
    const idleLeft = cfg.idleSec - p.idletime;
    if (idleLeft < shutdownIn) { shutdownIn = Math.max(0, idleLeft); reason = 'idle'; }
  } else if (cfg.loadTimeoutSec - age < shutdownIn) {
    shutdownIn = Math.max(0, cfg.loadTimeoutSec - age);
    reason = 'model never loaded';
  }
  return {
    id: pod.id,
    status: pod.status,              // PROVISIONING, STARTING, RUNNING, EXITED, ...
    ready,                           // true once the model is loaded and answering
    url: podUrl(pod.id),
    gpu: pod.gpu?.id || pod.machine?.gpuDisplayName || '',
    costPerHour: Number(pod.cost ?? pod.costPerHr ?? 0),
    ageSec: Math.round(age),
    idleSec: ready ? Math.round(p.idletime) : null,
    shutdownInSec: Math.round(shutdownIn),
    shutdownReason: reason,
    busy: ready ? p.idle === 0 : false,
  };
}

async function terminate(env, id) {
  const r = await runpod(env, 'POST', `/pods/${id}/action`, { action: 'terminate' });
  if (!r.ok && r.status !== 404 && r.status !== 409) throw new Error(`Runpod: couldn't stop the pod (${r.status})`);
}

// ---------- Actions ----------
async function status(env) {
  const pods = await ourPods(env);
  if (!pods.length) return { pod: null };
  return { pod: await describe(env, pods[0]), extra: pods.length - 1 };
}

async function start(env, body) {
  const existing = await ourPods(env);
  if (existing.length) return { pod: await describe(env, existing[0]), note: 'already running' };
  if (!body.modelUrl) throw new Error('No model link was sent.');
  if (!body.password) throw new Error('Set a pod password in the app first.');
  const args = [
    '--usecuda', '--gpulayers', '999',
    '--contextsize', String(body.contextSize || 32768),
    '--flashattention', '--quiet',
    '--password', body.password,
  ].join(' ');
  const gpus = Array.isArray(body.gpus) && body.gpus.length ? body.gpus : DEFAULT_GPUS;
  const tried = [];
  for (const gpu of gpus) {
    const r = await runpod(env, 'POST', '/pods', {
      name: POD_NAME,
      image: IMAGE,
      gpu: { id: gpu, count: 1 },
      cloud: 'SECURE',
      disk: Number(body.diskGb || 50),
      ports: ['5001/http'],
      env: { KCPP_MODEL: body.modelUrl, KCPP_ARGS: args },
    });
    if (r.ok) return { pod: await describe(env, r.data), gpuTried: tried };
    if (r.status === 402) throw new Error('Your Runpod balance is too low. Add credit in Runpod.');
    if (r.status === 401) throw new Error('Runpod rejected the API key in the Worker.');
    tried.push(`${gpu}: ${r.status}`);
    if (r.status === 422) throw new Error(`Runpod rejected the request: ${r.data?.detail || r.data?.title || 422}`);
    // 400/403/5xx: that GPU isn't available right now. Try the next one.
  }
  throw new Error('No GPU is free right now. Try again in a few minutes. (' + tried.join(', ') + ')');
}

async function stop(env) {
  const pods = await ourPods(env);
  for (const p of pods) await terminate(env, p.id);
  return { stopped: pods.length };
}

// Runs every minute (cron trigger): the auto-off.
async function watchdog(env) {
  const pods = await ourPods(env);
  for (const pod of pods) {
    const d = await describe(env, pod);
    if (d.shutdownInSec <= 0 || ['EXITED', 'ERROR'].includes(pod.status)) {
      await terminate(env, pod.id);
      console.log(`Auto-off: terminated ${pod.id} (${d.shutdownReason})`);
    }
  }
}

// ---------- HTTP ----------
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (!env.APP_KEY || req.headers.get('X-App-Key') !== env.APP_KEY) return json({ error: 'Wrong app key.' }, 401, h);
    if (!env.RUNPOD_API_KEY) return json({ error: 'The Worker has no RUNPOD_API_KEY set.' }, 500, h);
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && path === '/status') return json(await status(env), 200, h);
      if (req.method === 'POST' && path === '/start') return json(await start(env, await req.json().catch(() => ({}))), 200, h);
      if (req.method === 'POST' && path === '/stop') return json(await stop(env), 200, h);
      return json({ error: 'Not found' }, 404, h);
    } catch (e) {
      return json({ error: e.message || String(e) }, 502, h);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env));
  },
};
