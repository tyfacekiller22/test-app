# Companion: private chat app (stage 1: core chat)

A home-screen web app for chatting with the model running on your Runpod pod.
Chats, characters, your pod address and password are stored only on your phone.

## What's in stage 1
- Chat list, new chat (character, you, situation, opening message), example character (Mara)
- Chat screen: live typing replies, Stop button, Auto switch, Write for me, Narrate
  (long-press Narrate to give it a focus), Regenerate / Reply, swipe between versions
- "What happens next" box: stays active until you clear it, never shown in the chat
- Tap any message to edit it in place, or delete it. "More" (or long-press) adds copy,
  regenerate and "delete this and everything after"
- Replies are kept to 2 paragraphs by default (Settings → Max paragraphs per reply)
- Import (⬇ on the chat list): Perchance AI Character Chat exports/backups (.json),
  and SillyTavern-style character cards (.json)
- Chat settings (⋯ or tap the name): edit the character/you/situation, chat-only
  instructions, narrator instructions, global instructions on/off, save on/off,
  view the full prompt, delete the chat
- Settings: pod address + password with a connection test, global instructions,
  narrator default, banned phrases, model settings (temperature, min-p, DRY, XTC…)

Coming in later stages: character/situation libraries and imports (2), pod start/stop,
auto-shutdown and a permanent pod (3), memory summaries, pinned memories, generated
details, tech support helper, backups and spending (4).

## Files
```
index.html            the page
css/app.css           all the styling (light + dark mode)
js/app.js             screens, buttons, chat logic
js/prompt.js          builds exactly what the model is told
js/api.js             talks to KoboldCpp on the pod
js/defaults.js        default instructions, banned phrases, sampler values, example character
js/store.js           saves data on the device
js/format.js          turns *actions* into italics, safely
js/importer.js        reads Perchance exports and character cards
sw.js                 lets it run as a home-screen app
manifest.webmanifest  app name and icons
icons/                app icons
```

## Try it on your Mac (VS Code)
The app has to be served by a small local web server (opening index.html directly won't work).

Option A: in VS Code, install the **Live Server** extension, right-click `index.html` → **Open with Live Server**.

Option B: in VS Code's terminal (Terminal → New Terminal):
```
cd app
python3 -m http.server 8000
```
then open http://localhost:8000 in your browser.

Then: ⚙ Settings → paste your pod address and password → **Test connection**.
Your pod address is in Runpod: your pod → **Connect** → the port 5001 link
(looks like `https://xxxxxxxx-5001.proxy.runpod.net`).

## Put it on GitHub Pages
1. Put the contents of this `app` folder in your GitHub repository (the files at the top level of the repo, or in a `docs/` folder).
2. On GitHub: repo → **Settings** → **Pages** → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` (or `/docs`) → Save.
3. After a minute, it's live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

## Install on your iPhone
Open that address in **Safari** → Share button → **Add to Home Screen**.
Then enter the pod address and password in Settings (they're stored on the phone, not in the code).

## Notes
- Each new Runpod pod has a new address until stage 3 sets up a permanent pod: update it in Settings.
- If iPhone ever clears the app's data, chats are lost; backups come in stage 4.
- The app talks to the pod directly over HTTPS. Nothing goes through GitHub.
