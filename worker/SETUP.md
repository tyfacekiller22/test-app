# Setting up pod control (about 15 minutes, free)

The app starts and stops your Runpod pod through a small program called a **Cloudflare Worker**.
It also runs the **auto-off**: every minute it checks the pod and shuts it down after
15 minutes without messages, after 3 hours no matter what, or if the model never finishes loading.
Because it runs in the cloud, it works even when your phone is locked or the app is closed.

Your Runpod API key is stored in the Worker, not on your phone.
Cloudflare's free plan covers this easily.

## 1. Create a Runpod API key
1. Runpod → **Settings** → **API Keys** → **Create API Key**.
2. Name it `companion-worker`. Give it read/write access (it needs to create and delete pods).
3. Copy the key. You'll paste it into Cloudflare in step 3. (Runpod only shows it once.)

## 2. Create the Worker
1. Make a free account at **dash.cloudflare.com** (or sign in).
2. Left menu → **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker**
   (start from "Hello World").
3. Name it `companion` → **Deploy**.
4. Click **Edit code**. Delete everything in the editor, paste the whole contents of
   `worker/worker.js` from this folder, then click **Deploy**.
5. Copy the Worker's address shown at the top, like `https://companion.YOURNAME.workers.dev`.

## 3. Add its settings
In the Worker: **Settings** → **Variables and Secrets** → **Add**:

| Type   | Name             | Value |
|--------|------------------|-------|
| Secret | `RUNPOD_API_KEY` | the Runpod key from step 1 |
| Secret | `APP_KEY`        | a long random password you make up (letters and numbers). You'll also put it in the app. |
| Text   | `ALLOWED_ORIGIN` | `https://tyfacekiller22.github.io` |

Optional (defaults in brackets): `IDLE_MINUTES` [15], `MAX_HOURS` [3], `LOAD_TIMEOUT_MINUTES` [30].

Click **Deploy** / **Save** after adding them.

## 4. Turn on the auto-off timer
In the Worker: **Settings** → **Triggers** → **Cron Triggers** → **Add**:
`* * * * *` (that means every minute) → **Add trigger**.

## 5. Connect the app
In the app: ⚙ **Settings** → **Pod control**:
- **Worker address**: the address from step 2.5
- **App key**: the `APP_KEY` from step 3
- **Pod password** (under "Your pod"): any password; each new pod is started with it.

Tap **Test Worker**. It should say "Connected to your Worker. Pod: off."

## Using it
- Main screen → **Start**. The app asks Runpod for a GPU (A40 first, then A6000, L40, L40S,
  RTX 6000 Ada), shows "Waking up…" while the model downloads and loads (about 5–10 min),
  then connects by itself.
- **Stop** shuts the pod down right away (the pod is deleted, so billing stops completely).
- In a chat, a banner appears 2 minutes before auto-off. Tap **Keep on** to reset the timer.
- "This month" on the main screen is an estimate kept on your phone. Runpod's billing page is exact.
- The main screen also shows your **Runpod balance** and roughly how many hours of chat it covers.
  Set the low-balance warning in the app's Settings → Pod control (0 turns it off).

## Updating the Worker
When `worker/worker.js` changes: Worker → **Edit code** → select all, paste the new
`worker/worker.js` → **Deploy**. Your settings, secrets and cron trigger stay as they are.

## If something goes wrong
- **"Wrong app key"**: the app key in the app doesn't match `APP_KEY` in the Worker.
- **"Runpod rejected the API key"**: re-check `RUNPOD_API_KEY` in the Worker.
- **"No GPU is free right now"**: try again in a few minutes.
- **Stuck on "Waking up" for over 15 minutes**: open the pod in Runpod and check its **Logs**.
  The auto-off removes a pod whose model never loads after 30 minutes.
- To see what the auto-off did: Worker → **Logs** (look for "Auto-off: terminated").
- **No balance on the main screen**: the Worker couldn't read it from Runpod. Everything else still works.
  Check the Worker was updated (see above). Runpod's balance comes from its older GraphQL API, which
  Runpod could change. Your balance is always on Runpod's own dashboard.
