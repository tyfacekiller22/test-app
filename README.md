# Companion: private chat app (stage 1: core chat)

A home-screen web app for chatting with the model running on your Runpod pod.
Chats, characters, your pod address and password are stored only on your phone.

## What's in stage 1
- Chat list, new chat (character, you, situation, opening message), example character (Mara)
- Chat screen: live typing replies, Stop button, Auto switch, Write for me, Narrate
  (long-press Narrate to give it a focus), Regenerate / Reply, swipe between versions
- "What happens next" box: stays active until you clear it, never shown in the chat
- Trash button under every message deletes it in one tap (with Undo)
- Tap any message to edit it in place (the bottom area hides to make room). "More" (or long-press) adds copy,
  regenerate and "delete this and everything after"
- Replies are kept to 2 paragraphs by default (Settings → Max paragraphs per reply)
- Import (⬇ on the chat list): Perchance AI Chat files (perchance.org/ai-chat),
  Perchance AI Character Chat exports/backups (.json),
  and SillyTavern-style character cards (.json)
- Chat settings (⋯ or tap the name): edit the character/you/situation, chat-only
  instructions, narrator instructions, global instructions on/off, save on/off,
  view the full prompt, delete the chat
- Settings: pod address + password with a connection test, global instructions,
  narrator default, banned phrases, model settings (temperature, min-p, DRY, XTC…)

Stage 3 (pod control): Start/Stop on the main screen, "Waking up…" while the model loads,
auto-off after 15 idle minutes or 3 hours (runs in a free Cloudflare Worker, see worker/SETUP.md),
a 2-minute warning banner with Keep on, and a monthly spending estimate.

Added 2026-10-10:
- **Clear conversation**: chat ⋯ settings (or long-press a chat on the Chats screen). Deletes the messages and
  the "what happens next" direction, keeps characters, situation and instructions, and restarts from the
  opening line if there is one. Undo is offered for a few seconds.
- **Group chats**: in New chat or chat settings, tap "+ Add another character". One model plays everyone
  (no extra cost). Each reply shows who's speaking. The "Reply from" names under the direction box make that
  character reply (sending anything typed first); Send lets the model choose who speaks. Regenerate keeps the
  same speaker.
- **Creator** (✦ Create on the Chats screen, or ✦ in the Library): a conversation with your model that helps
  you build AI characters, characters for you, situations, or a whole group. Drafts appear as cards:
  "Review & save" opens the editor so you can check them before saving; if a draft has the same name as
  something saved, you can update it or save it as new. "Rework something saved…" shares a library item with it.
  Its instructions are editable in Settings → Creator instructions. Uses the same pod (pod must be on).

Added 2026-10-11:
- **Runpod balance** on the Chats screen, with roughly how many hours of chat it covers. A warning appears when it
  drops below the amount in Settings → Pod control → Low-balance warning (default $5, 0 = off), and Start asks
  first if the balance is low. Needs the updated worker/worker.js pasted into Cloudflare (see worker/SETUP.md).

Added 2026-10-11 (pictures):
- **Picture button** (image icon in the action row): the chat model describes the current moment, then the
  image model on the pod draws it (photorealistic, RealVisXL V5.0 by default). Long-press any message →
  "Picture this moment" pictures an earlier point. Tap a picture to view it full screen: Save (to Photos),
  New version, Edit (change the description and redraw), Delete. Pictures are never sent to the chat model.
- **Appearance** field for AI characters and your characters (library, New chat, chat settings, Creator drafts).
  Used in pictures and in the chat prompt; concrete details keep people looking more alike between pictures.
- Regenerate is now an icon (it switches to a Reply icon when the last message isn't a reply).
- Settings → Pictures: image model link (empty = pictures off), photo style, things to avoid, size, steps, CFG, sampler.
- Backups can include pictures (off by default; about 0.3MB each).
- Needs the updated worker/worker.js in Cloudflare (it loads the image model when the pod starts).

Changed 2026-10-11 (pictures, v13):
- Default image model is now **Z-Image Turbo** (Q6_K, with its Qwen3-4B text encoder and VAE, about 9GB):
  it follows whole-scene descriptions (who does what, where) much better than SDXL. RealVisXL is still one tap
  away in Settings → Pictures → Image model. The chat model writes full-sentence descriptions for Z-Image and
  short phrases for SDXL. 8 steps, CFG 1. Needs the updated worker/worker.js (it passes --sdllm and --sdvae).

Added 2026-10-11 (v14):
- **Generate photo** for AI characters and your characters (Library → open one → ✦ Generate photo, also when saving
  a Creator draft). The chat model writes a portrait description from Appearance + description, the image model
  draws it. Chats whose character had no photo pick up the new one automatically.

Added 2026-10-11 (v15):
- Tapping a picture opens a full-screen **gallery of all the chat's pictures** (the latest version of each), starting at that one.
  Swipe left/right to move through them, swipe down or ✕ to close. Save / New version / Edit / Delete work on the
  picture you're looking at (Delete removes just that version, with Undo).

Added 2026-10-11 (v16):
- **Review descriptions before drawing** (Settings → Pictures, on by default): after tapping Picture (or Generate photo),
  a sheet shows the scene, the moment and the description. Edit it, tap **Rewrite** for a new one, or **Draw**.
  Closing the sheet cancels.
- The screen stays awake while a picture or profile photo is being made (Screen Wake Lock; iPhone home-screen apps
  support it from iOS 18.4).

Added 2026-10-11 (v19):
- Image model preset **LUSTIFY! V7** (photorealistic SDXL trained mainly on explicit images), from a Hugging Face
  copy whose SHA256 matches the official release. Short-phrase descriptions, 30 steps, CFG 4. Like RealVisXL, it's
  weaker than Z-Image at scenes with several people interacting.

Coming in later stages: character/situation libraries (2), memory summaries, pinned memories, generated
details, tech support helper, backups and spending (4).

## Files
```
index.html            the page
css/app.css           all the styling (light + dark mode)
js/app.js             screens, buttons, chat logic
js/prompt.js          builds exactly what the model is told (including group scenes)
js/creator.js         the Creator screen (build characters and situations with AI)
js/images.js          stores pictures on the phone, saving to Photos
js/api.js             talks to KoboldCpp on the pod
js/defaults.js        default instructions, banned phrases, sampler values, example character
js/store.js           saves data on the device
js/format.js          turns *actions* into italics, safely
js/importer.js        reads Perchance exports and character cards
js/pod.js             start/stop/status via your Cloudflare Worker
worker/worker.js      the Cloudflare Worker (pod control + auto-off)
worker/SETUP.md       how to set up the Worker
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
