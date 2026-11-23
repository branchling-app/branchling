# Branchling for Claude Code

Install in Claude Code:

```
/plugin install branchling --marketplace branchling-app/branchling
```

The plugin is free. The Branchling apps for Mac and iPhone are paid and sold separately.

Branchling keeps an almanac of your project while you work in Claude Code. Every test run, build, commit and merge in your git projects becomes a one-line entry, on the branch it happened on, with a small score: progress +1, problem −1, solution +2, a hold 0. Your own Claude keeps the project's goal and plan up to date, and the free plugin works on its own in the terminal. The Branchling app for Mac draws the same almanac as a tree of branches with characters, a road ahead to the goal and a finish forecast.

The plugin has no server and never calls a model by itself: the almanac is a folder of plain JSON lines in `~/.branchling`. Only when you connect the iPhone app does it leave your machine, sealed with a key that only your own devices hold, on a separate `branchling` branch of your own GitHub repository (see [SETUP.md](SETUP.md)).

## Get started

1. Install the plugin in Claude Code.
2. Work as usual. Every git project you open in Claude Code joins the almanac by itself, named after its folder. `/branchling off` leaves the current project out; `/branchling link <name>` gives it another name.
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
| `/branchling link <name>` | Names this project's almanac (projects join by themselves) |
| `/branchling off` | Leaves this project out of the almanac |
| `/branchling phone [<key> \| off]` | Sends the sealed almanac to your iPhone through GitHub, or stops it |
| `/branchling plan` | Asks Claude to write or refresh the goal and plan |
| `/branchling goal <sentence>` | Sets the goal yourself (90 characters at most); Claude keeps it |
| `/branchling tasks` | Lists the planned tasks and their status |
| `/branchling progress <text>` | Records progress by hand (also `problem` and `hold`) |
| `/branchling solve <no> <text>` | Solves open problem number `<no>` |
| `/branchling ask <text>` | Records something that waits for an OK |
| `/branchling approve <no> [text]` | Gives that OK |
| `/branchling open` | Lists what is still waiting: open problems, approvals and holds |
| `/branchling usage` | Claude tokens and turns spent in this project over the last week |

## On your iPhone

The Branchling iPhone app shows one sentence. Paste it into Claude Code and Claude sets everything up: on a computer it installs this plugin, in Claude Code on the web it adds a small recorder to the repository. Details in [SETUP.md](SETUP.md).

## Where the data lives

```
~/.branchling/projects/<project>/entries/<day>.jsonl   one line per entry
~/.branchling/projects/<project>/plan.json             goal and tasks, written by Claude
~/.branchling/settings.json                            { "autoRefresh": true }
```

Delete a project's folder and it is gone. The Mac app reads the same folder; to rename or delete a project there, right-click it in the sidebar.
