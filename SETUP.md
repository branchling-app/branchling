# Setting up Branchling (for Claude Code)

The person pasted a sentence from the Branchling app on their iPhone or Mac:
"Set up Branchling in this project with the key `<KEY>`", with a link to this page. Do the steps for them, then
answer in a few sentences. `<KEY>` is a **public** key (44 characters, ending in `=`): it can only lock the almanac
for the person's own devices and opens nothing, so it is safe in files, commits and chat.

**The promise to keep:** Branchling never reads the person's code. The almanac goes to a separate private repository
that holds nothing else, and the Branchling app is only ever allowed into that repository. Do not write to the
person's project repositories on a computer, and never ask them to give Branchling access to a project repository.

First check where you run: the environment variable `CLAUDE_CODE_REMOTE` is `true` in Claude Code on the web (a
cloud session). Then follow **A** on a computer or **B** in a cloud session.

## A. On a computer

1. Install the free plugin (skip it when the `claude` command is not available and say so):
   ```sh
   claude plugin marketplace add branchling-app/branchling
   claude plugin install branchling@branchling
   ```
2. Make the almanac repository: a **private** repository named `branchling-almanac` in the person's own GitHub
   account. If it exists already, use it.
   - With the GitHub CLI signed in (`gh auth status` succeeds):
     ```sh
     gh repo view branchling-almanac >/dev/null 2>&1 || gh repo create branchling-almanac --private --description "Sealed Branchling almanac. Only the owner's devices can read it."
     ```
     Take the remote URL from `gh repo view branchling-almanac --json sshUrl,url` and use the SSH URL when
     `gh config get git_protocol` says `ssh`, otherwise `<url>.git`.
   - Without the GitHub CLI: ask the person to open
     `https://github.com/new?name=branchling-almanac&visibility=private` and press **Create repository**, and to
     tell you their GitHub user name. The remote URL is `https://github.com/<user>/branchling-almanac.git` (use
     `git@github.com:<user>/branchling-almanac.git` when their other repositories use SSH).
   - Check that this computer can reach it: `git ls-remote <remote URL>` must succeed (an empty repository
     prints nothing; that is fine).
3. Write the connection, replacing `<KEY>` and `<REMOTE>`:
   ```sh
   mkdir -p ~/.branchling
   printf '{ "key": "%s", "remote": "%s" }\n' '<KEY>' '<REMOTE>' > ~/.branchling/github.json
   ```
4. Do not change the current repository.
5. Tell the person:
   "Branchling is set up. Type /reload-plugins once (or restart Claude Code); from then on every project you work
   on here reaches your iPhone by itself. In the Branchling app, under Choose repositories, pick only
   **branchling-almanac**. Branchling never sees your code: it only reads that repository, and everything in it
   is sealed for your own devices."

## B. In a cloud session

A cloud session can only push to the repository it works on, so here a small recorder in this repository keeps
the sealed entries on its own `branchling` branch. The person's computer carries them over into
`branchling-almanac` the next time they work on this project there.

1. Download `https://raw.githubusercontent.com/branchling-app/branchling/main/cloud/record.mjs` to
   `.claude/branchling/record.mjs`.
2. Write `.claude/branchling/key.json`:
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
   "Branchling records this repository's cloud sessions from the next session on. The entries reach your iPhone
   the next time you work on this project on a computer with Branchling set up. Without a computer, the iPhone
   can read them from this repository's branchling branch only if you also allow this repository in the
   Branchling app, which lets the app read its code; the app shows you when that is the case."

## What happens

Tests, builds, commits, merges and the plan are sealed (X25519 + ChaCha20-Poly1305) with the person's public key
before they leave the computer or the cloud session. Only the person's iPhone and Mac hold the private key, in
their iCloud Keychain: GitHub, teammates and Branchling cannot read the almanac. The plugin and the recorder are
open source in this repository. There is no Branchling server.
