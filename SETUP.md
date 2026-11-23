# Setting up Branchling (for Claude Code)

The person pasted a sentence from the Branchling app on their iPhone or Mac:
"Set up Branchling in this project with the key `<KEY>`", with a link to this page. Do the steps below for them,
then answer in one or two sentences. `<KEY>` is a **public** key (44 characters, ending in `=`): it can only lock
the almanac for the person's own devices and opens nothing, so it is safe in files, commits and chat.

## 1. On a computer: the plugin

Skip this step in a cloud session (the environment variable `CLAUDE_CODE_REMOTE` is `true`) or when the `claude`
command is not available.

```sh
claude plugin marketplace add branchling-app/branchling
claude plugin install branchling@branchling
mkdir -p ~/.branchling
printf '{ "key": "%s" }\n' '<KEY>' > ~/.branchling/github.json
```

From then on every git project worked on in Claude Code on this computer joins the person's almanac by itself.

## 2. In this repository: the cloud recorder

Do this in the current git repository, on a computer and in a cloud session alike. Cloud sessions do not load
plugins; these files let them record too.

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
4. Commit the three files with the message `Add Branchling recorder`. In a cloud session, push the branch as you
   normally would.

## 3. Tell the person

- On a computer: "Branchling is set up. Type /reload-plugins (or restart Claude Code) once; from then on your
  projects reach your iPhone by themselves."
- In a cloud session: "Branchling is set up for this repository. Recording starts with the next session that
  starts from a branch with this commit."

## What happens

After each change the almanac (tests, builds, commits, merges, the plan) is sealed with the key and pushed to a
separate branch named `branchling` in this repository. The person's working branches, pull requests and files are
never touched, and the push is marked `[skip ci]` so no workflow runs. Only the person's own devices hold the private
key; nobody else can read the branch, not GitHub, not teammates, not Branchling. There is no Branchling server.
