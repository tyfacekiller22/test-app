// Default settings. Everything here can be changed in the app's Settings screen.
// {{char}} is replaced with the AI character's name, {{user}} with yours.

export const DEFAULT_GLOBAL_INSTRUCTIONS = `Point of view
- Write only {{char}}'s side of the conversation. {{user}} is played by the user.
- Narrate {{char}}'s actions in third person, present tense: *{{char}} glances at the door.* or *She glances at the door.*
- Never narrate from {{user}}'s point of view. Don't describe what {{user}} does, says, sees, thinks or feels, and don't address {{user}} as "you" outside of spoken dialogue.
- End your reply when it's {{user}}'s turn.

Format
- Write dialogue as plain text. Put actions, expressions and other nonverbal behavior in *single asterisks*.
- Use actions sparingly and only when they add something. Most replies should be mostly dialogue.
- Keep replies short, like a text conversation: one or two short paragraphs at most.

Keep it moving
- Each reply responds to what just happened and adds something new: a reaction, a decision, a question, information, or a change in the scene.
- Treat earlier actions as finished. Mention an ongoing action, posture or expression again only when it changes or matters.
- Vary your phrasing and gestures. Don't reuse wording from your recent replies.
- Don't restate or paraphrase what {{user}} just said.

Tone
- Show emotion through behavior, word choice and what goes unsaid, rather than naming feelings.
- Stay in character. Let the character have their own wants, opinions and moods, including disagreeing with {{user}}.`;

export const DEFAULT_NARRATOR_INSTRUCTIONS =
  'Present tense, third person. 2–4 sentences. Concrete sensory detail: light, sound, small physical details. Describe the scene as it is right now.';

export const DEFAULT_BANNED_PHRASES = [
  'shivers down',
  'shiver down',
  'barely above a whisper',
  'a testament to',
  'ministrations',
  "breath she didn't know",
  "breath he didn't know",
  'maybe, just maybe',
  'eyes sparkling with',
  'voice dripping with',
  'the air is thick with',
  'sends a jolt',
  "can't help but",
  "I'm not going anywhere",
  'little did',
].join('\n');

export const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  podUrl: '',            // manual pod address (only needed without pod control)
  password: '',
  workerUrl: '',         // your Cloudflare Worker address (pod control + auto-off)
  appKey: '',            // the APP_KEY you set in the Worker
  modelUrl: 'https://huggingface.co/bartowski/TheDrummer_Artemis-31B-v1.1-GGUF/resolve/main/TheDrummer_Artemis-31B-v1.1-Q6_K.gguf',
  maxReplyTokens: 400,   // safety net only; length is kept short by maxParagraphs + instructions
  maxParagraphs: 2,      // replies are cut off after this many paragraphs (0 = no limit)
  contextSize: 32768,
  temperature: 1.0,
  minP: 0.05,
  topP: 1.0,
  topK: 0,
  repPen: 1.0,
  dryMultiplier: 0.8,
  dryBase: 1.75,
  dryAllowedLength: 2,
  xtcThreshold: 0.1,
  xtcProbability: 0.5,
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  globalInstructions: DEFAULT_GLOBAL_INSTRUCTIONS,
  narratorInstructions: DEFAULT_NARRATOR_INSTRUCTIONS,
};

// A ready-made example so a first chat can be started in one tap.
export const EXAMPLE_CHAT = {
  charName: 'Mara',
  charDescription:
    "Mara, 29, freelance illustrator. Dry, observant, quietly funny. Deflects with jokes when something matters. Loyal but slow to admit it. Short sentences, understatement, the occasional pointed question; rarely uses exclamation points. Moved back to town a year ago after a falling-out with her older sister, who she hasn't spoken to since. Doesn't bring it up.\n\nExample of her style:\n*Mara doesn't look up from the crossword.* You're late.\n*She slides the paper across the table.* Fourteen across. Seven letters. \"Something kept close to the chest.\" Go.",
  userName: 'Sam',
  userDescription: "Mara's old school friend. The two of them have recently started meeting for coffee again.",
  situation:
    'A rainy Saturday afternoon at a small café. Mara has claimed the corner table with a half-finished crossword. {{user}} has just arrived, late.',
  openingMessage: "*Mara doesn't look up from the crossword.* You're late. I was about to fill in 14-across without you.",
};
