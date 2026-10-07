# team-hub
> A shared panel of team conventions, recommended mods, budgets and rules, synced through the repo.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Your team keeps one file in the repository, `.claude/team.json`: its conventions, the mods it recommends, the guard level and budgets it expects, and the notification rules it wants. team-hub reads it and shows it in a **Team** panel, adds the conventions to Claude's system prompt, lists which recommended mods you are missing (with a one-click install), and tells you where your own settings differ from the team's, for example a token budget higher than the team's. Maintainers edit the file in the panel; the change travels like any other: review it, commit it, push it.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install team-hub@claude-mods
```

## Usage
`/team` opens the panel (a **Team** tab of the Claude Mods panel with `mods-hub`, a pane of its own without it). It shows the conventions, each recommended mod as ✓ installed, ○ installed but off or ✗ missing (an **Install** button each, **Install all missing** for several), and a list of differences with an **Align** button for the ones it can fix. **Edit** (owners only) opens an editor with a working copy: conventions, mods, guard level, budgets, notification routes and owners; nothing is written until **Save**, and Save tells you to commit the file.

A starting point for a repository without one: `/team init`.

```json
{
  "version": 1,
  "name": "Acme Web Team",
  "conventions": ["Write small commits.", "Run the tests before a pull request."],
  "recommendedMods": ["secret-shield", "guardian", "token-budget"],
  "guard": { "level": "strict" },
  "budget": { "sessionUsd": 5, "sessionTokens": 200000, "dailyUsd": 20 },
  "notifications": { "critical": "always", "error": "away" },
  "owners": ["alice@acme.com", "Bob"]
}
```

| Key | Meaning |
| --- | --- |
| `conventions` | Text, or a list of lines (one line per entry reads best in a pull request). Up to 4,000 characters in the file, 1,500 of them in the system prompt. |
| `recommendedMods` | Mod names. Installed from `marketplace` (default `plagemes/claude-mods`, named `marketplaceName`, default `claude-mods`). |
| `guard.level` | `off`, `standard` or `strict`: the level the team expects from guardian. |
| `budget` | `sessionUsd`, `sessionTokens`, `dailyUsd`: limits your own settings must not exceed (checked against token-budget's and daily-spend's options; 0 there means no limit, which counts as a difference). |
| `notifications` | Per level (`info`, `success`, `warning`, `error`, `critical`) the weakest route you may have: `terminal`, `away` or `always`, as in the hub's `/hub route`. |
| `owners` | Who may edit here, matched on `git config user.email` or `user.name`. Empty: anyone. |

| Command | What it does |
| --- | --- |
| `/team` · `show` · `check` | Open the panel · the same as text · only the differences. |
| `/team install [mod… \| all]` | Install the missing recommended mods (adds the marketplace if needed; then run `/reload-plugins`). |
| `/team align` | Set your budget options to the team's values (through `/config`; a locked row is reported). |
| `/team init` · `reload` | Create a starter file · read the file again. |
| `/team add-mod` · `remove-mod` · `convention <text>` · `guard <level>` · `budget <key> <n\|none>` · `route <level> <route\|none>` · `owner add\|remove <who>` | Owners' edits as commands (the same checks as the editor; the only way to edit on mobile). |

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `injectConventions` | `true` | Add the team's conventions to the system prompt. |
| `notifyDrift` | `true` | One notice per session when your settings differ from the team's or recommended mods are missing. |

## How it works
- **The file is the source of truth.** It is read at session start and again within a minute of changing on disk (a `git pull`); the conventions section of the prompt is built from it only then, so the prompt text stays stable between changes. A file that is not valid JSON is explained and ignored; a part that is wrong (a bad mod name, a negative budget, an unknown level) is dropped and listed, and unknown keys are kept when the file is saved.
- **Who may edit** is checked on your machine against `owners`, which is advice for the interface, not security: the real control is your repository (CODEOWNERS and review). A secret in the file is refused on save, flagged on load and masked before it reaches the prompt: the file is committed to git.
- **Drift** compares the file with `/config` rows (`token-budget.budgetUsd`, `token-budget.budgetTokens`, `daily-spend.dailyLimit`), with the hub's notification routes and with the `guardian.policy` fact's level when guardian shares it. A setting whose mod is not installed is not a difference (the missing mod is). With no hub the route and guard checks are skipped, except that a required guard level with guardian not installed is flagged.
- **Installing** uses the `claude plugin` CLI exactly as mod-store does (its argument vectors, copied): `marketplace add` when needed, `install <mod>@<marketplace> --scope user`, one after another.
- **With `mods-hub`**: it registers the Team tab, publishes `x.team-hub.drift` (`count`, `items`, `missingMods`, `disabledMods`) whenever the drift changes, shares the fact `team-hub.policy` (the team's guard level, budgets and routes, for guardian and others to read), and sends one `info` notice per session. Without it the notice is a toast, the panel is a pane, and everything else works the same.
- **Limits.** It reads and writes one file in the repository root of the session; it never commits or pushes. Several team files in a monorepo are not supported (the repository root's file is used). Routes and the guard level are advice here: it does not change them for you (it prints the `/hub route …` command).
