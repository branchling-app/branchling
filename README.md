# Branchling for Claude Code

Install in Claude Code:

```
/plugin install branchling --marketplace branchling-app/branchling
```

The plugin is free. The Branchling apps for Mac and iPhone are paid and sold separately.

Branchling keeps an almanac of your project while you work in Claude Code. Every test run, build, commit and merge in your git projects becomes a one-line entry, on the branch it happened on, with a small score: progress +1, problem −1, solution +2, a hold 0. Your own Claude keeps the project's goal and plan up to date, and the free plugin works on its own in the terminal. The Branchling app for Mac draws the same almanac as a tree of branches with characters, a road ahead to the goal and a finish forecast.

The plugin has no server and never calls a model by itself: the almanac is a folder of plain JSON lines in `~/.branchling`. It reaches your iPhone only through your own iCloud: Branchling for Mac sends it, or, on another computer, the plugin seals it with a key that only your own devices hold and writes it there itself. No other account and no permission is needed, your repositories are never written to, and Branchling never reads your code (see [SETUP.md](SETUP.md)).

## Get started

1. Install the plugin in Claude Code.
2. Work as usual. A git repository joins the almanac by itself, named after its folder, as soon as Claude Code tests, builds, commits or edits files in it (not merely because a session was opened there). `/branchling off` leaves a project out; `/branchling link <name> <folder>` gives it another name or adds a second repository to one project.
3. Run `/branchling plan`. Claude reads the repository and writes the goal (one sentence) and the road ahead (sized tasks, S, M or L).

From then on the almanac fills itself as you and Claude work:

- **Tests and builds.** A failing run is a problem; the next passing run solves it.
- **Commits.** Each commit is progress on its branch. End the subject with a task tag, such as `Add sign-in [t3]`, and task t3 is done.
- **Merges.** A merged branch curves back into the trunk and stops speaking for the project.
- **Approvals.** When Claude stops for your OK it can record the question with the `ask` tool, and closes it once you answer.

Once a day, at a quiet moment and only when something happened, Claude refreshes the plan in your session. Turn this off in `~/.branchling/settings.json` (`{ "autoRefresh": false }`) or in the app's settings.

## Commands

| Command | What it does |
| --- | --- |
| `/branchling` | Today's score, open problems and the plan in one glance |
| `/branchling link <name> [folder]` | Records a folder (this one if left out) into the project `<name>`; several folders can share one project |
| `/branchling off [folder \| name]` | Stops recording a folder, or every folder of a project; what was recorded stays |
| `/branchling phone [now \| off]` | Shows the iPhone connection (computers without Branchling for Mac), sends now, or stops it |
| `/branchling plan [folder \| name]` | Asks Claude to write or refresh the goal and plan; when the session worked in several projects it asks which |
| `/branchling goal <sentence>` | Sets the goal yourself (90 characters at most); Claude keeps it |
| `/branchling tasks` | Lists the planned tasks and their status |
| `/branchling progress <text>` | Records progress by hand (also `problem` and `hold`) |
| `/branchling solve <no> <text>` | Solves open problem number `<no>` |
| `/branchling ask <text>` | Records something that waits for an OK |
| `/branchling approve <no> [text]` | Gives that OK |
| `/branchling open` | Lists what is still waiting: open problems, approvals and holds |
| `/branchling usage` | Claude tokens and turns spent in this project over the last week |

A `/branchling` command typed while Claude is still working reaches Claude as plain text; Claude then runs it for you with the plugin's `command` tool.

## On your iPhone

The Branchling iPhone app asks where you use Claude Code and shows one sentence. Paste it into Claude Code and Claude sets everything up: on a computer it installs this plugin (and, without Branchling for Mac, keeps an iCloud token for it); in Claude Code on the web it adds a small recorder to the repository, whose sealed entries your computer passes on later. Details in [SETUP.md](SETUP.md).

## Where the data lives

```
~/.branchling/projects/<project>/entries/<day>.jsonl   one line per entry
~/.branchling/projects/<project>/plan.json             goal and tasks, written by Claude
~/.branchling/settings.json                            { "autoRefresh": true }
```

Delete a project's folder and it is gone. The Mac app reads the same folder; to rename or delete a project there, right-click it in the sidebar.

## Disconnecting and uninstalling

- **Stop recording a project:** `/branchling off <name>`, or in the Mac app right-click the project › Folders… › ✕. Deleting the project in the Mac app also stops it.
- **Stop sending to the iPhone:** without a Mac, `/branchling phone off`; with a Mac, quit Branchling for Mac (it only sends while open).
- **Remove what is in iCloud:** on the iPhone, Settings › your name › iCloud › Manage Account Storage › Branchling › Delete Data (on a Mac: System Settings › your name › iCloud › Manage). Only your devices can open it anyway.
- **Uninstall the plugin:** `claude plugin uninstall branchling@branchling`, then `claude plugin marketplace remove branchling`. Nothing else is left running.
- **Remove the local almanac too:** delete the `~/.branchling` folder.
- **Cloud sessions:** in each repository that has it, delete `.claude/branchling/`, remove the two Branchling hooks from `.claude/settings.json`, and delete the repository's `branchling` branch.
