# Setting up Branchling (for Claude Code)

The person pasted a sentence from the Branchling app on their iPhone, with a link to this page. It has one of two
forms:

- "Set up Branchling in this project with the key `<KEY>` as described at …" (they use a Mac with the Branchling app)
- "Set up Branchling in this project with the key `<KEY>` and the iCloud token `<ENV>` `<API>` `<WEB>` as described
  at …" (they use another computer: Windows, Linux, or a Mac without the app)

Do the steps for them, then answer in a few sentences.

- `<KEY>` is a **public** key (44 characters, ending in `=`). It can only seal the almanac for the person's own
  devices and opens nothing, so it is safe in files, commits and chat.
- `<ENV>` is `production` or `development`, `<API>` is 64 hexadecimal characters, `<WEB>` is a long token. Together
  they let this computer write into Branchling's own part of the person's iCloud and nowhere else. Keep them only in
  the file below; never put them in a repository, a commit, or anywhere else.

**The promise to keep:** Branchling never reads the person's code, and on a computer it never writes to their
repositories. The almanac goes into the person's own iCloud and nowhere else. There is no Branchling server.

First check where you run: the environment variable `CLAUDE_CODE_REMOTE` is `true` in Claude Code on the web (a
cloud session). Then follow **A** on a computer or **B** in a cloud session.

## A. On a computer

1. Install the free plugin (skip it when the `claude` command is not available and say so):
   ```sh
   claude plugin marketplace add branchling-app/branchling
   claude plugin install branchling@branchling
   ```
2. Only when the sentence has an iCloud token, write it with the key, readable only by this user (replace the
   placeholders):
   ```sh
   mkdir -p ~/.branchling
   ( umask 077; printf '{ "env": "%s", "api": "%s", "web": "%s", "key": "%s" }\n' '<ENV>' '<API>' '<WEB>' '<KEY>' > ~/.branchling/cloud.json )
   ```
   On Windows without a POSIX shell, write the same JSON to `%USERPROFILE%\.branchling\cloud.json`.
   Without a token (a Mac with the Branchling app), write nothing: the Mac app sends the almanac itself.
3. Do not change the current repository.
4. Tell the person, for a Mac with the Branchling app:
   "Branchling is set up. Type /reload-plugins once (or restart Claude Code). From then on every project you work on
   here is recorded, and Branchling for Mac sends it to your iPhone through your own iCloud while it is open.
   Branchling never sees your code."

   For another computer:
   "Branchling is set up. Type /reload-plugins once (or restart Claude Code). From then on every change is sealed
   with your key and written into your own iCloud within seconds; pull down in Branchling on the iPhone to see it.
   Branchling never sees your code. If I report that iCloud refused the connection, copy the sentence again on the
   iPhone and paste it here."

## B. In a cloud session

A cloud session cannot reach iCloud, so here a small recorder in this repository keeps the sealed entries on its
own `branchling` branch. The person's computer passes them on to their iCloud the next time they work on this
project there.

1. Download `https://raw.githubusercontent.com/branchling-app/branchling/main/cloud/record.mjs` to
   `.claude/branchling/record.mjs`.
2. Write `.claude/branchling/key.json` with the key only (never the iCloud token):
   ```json
   { "key": "<KEY>" }
   ```
3. Add these hooks to `.claude/settings.json`. Keep every setting and hook already there, and do not add them twice:
   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/branchling/record.mjs\" bash" }] }
       ],
       "Stop": [
         { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/branchling/record.mjs\" push" }] }
       ]
     }
   }
   ```
4. Commit the three files with the message `Add Branchling recorder` and push the branch as you normally would.
5. Tell the person:
   "Branchling records this repository's cloud sessions from the next session on. The entries wait, sealed, on this
   repository's branchling branch and reach your iPhone the next time you work on this project on your computer
   with Branchling set up."

## What happens

The plugin records tests, builds, commits, merges and the plan in `~/.branchling` on the computer. With a Mac,
Branchling for Mac puts them into the person's private iCloud database. Without one, the plugin seals each file
(X25519 + ChaCha20-Poly1305) with the person's public key and writes it there itself. Entries from cloud sessions
are sealed before they leave the session. Only the person's iPhone and Mac hold the private key, in their iCloud
Keychain. The plugin and the recorder are open source in this repository.
