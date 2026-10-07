# quiz-me
> /quiz asks you questions about the code Claude just wrote, to check you really understand it.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
`/quiz` turns the edits of Claude's last turn into a short multiple-choice quiz: what the code does for a given input, why a line is there, what would break if it changed. You answer one question at a time in a pane, see right away whether you were right and why, and get a score at the end. Scores are kept, so `/quiz stats` shows how well you keep up with the code you ship.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install quiz-me@claude-mods
```

## Usage
- `/quiz` asks about the last turn that edited files (5 questions by default); `/quiz 3` asks 3.
- `/quiz src/cart.ts` (or `/quiz 3 src/cart.ts`) asks about a file instead; with no recent edits, `/quiz` falls back to your uncommitted changes (`git diff HEAD`).
- The **Quiz** pane: `Question 2 of 5 ● ✗ ◉ ○ ○`, the question, four options to press (hotkeys `1`–`4`), then `✓ Right.` or `✗ Not quite: the answer is 3.` with the explanation, and **Next** (`n`). The last screen shows `🎓 Score: 4/5 (80%)`, the questions you missed with their answers, and **New quiz** (`r`).
- `/quiz stats`: `🎓 12 quizzes · 47/60 right (78%) · 5 perfect` and your latest results.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `questions` | number | `5` | Questions per quiz when you do not say (1–10). |
| `model` | string | `sonnet` | Model that writes the questions. |

## How it works
- `tool.call` on Edit, Write and NotebookEdit records what each edit replaced and with what; at `turn.complete` the last editing turn is kept per project (in `$.store`), so `/quiz` works after a restart too.
- `$.model.complete` writes the questions as JSON; malformed ones (not exactly four distinct options, no valid answer) are dropped, and the options are shuffled so the right one is not always first.
- The quiz lives in `$.state` and is drawn in a `Pane` on terminal and desktop; finished scores go to `$.store` (the last 200).
