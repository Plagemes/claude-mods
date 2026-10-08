# project-brain
> A self-organising project memory that learns which decisions, conventions and fixes matter and recalls them like a neural network.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Keeps a memory graph per project in `.claude/brain/`: decisions, conventions, lessons from fixes, terms, owners and open tasks, wired to the files, symbols and errors they are about. It learns as you work, with no command needed. Files edited together get linked, a failing test that passes after some edits becomes an *error → fix* lesson, and decisions stated in a turn ("we decided to use Postgres…", "d'ora in poi usa sempre pnpm") are saved, with a small model pulling out the rest in the background. On each prompt it recalls what matters by **spreading activation** from your words, the files in play and recent errors, so a memory can come back with no words in common with the prompt. It then adds a short note for Claude ("decided 2026-09-14: use Postgres for orders"). A small neural ranker learns from whether Claude actually used what it was told.

It starts with what the project already knows: `CLAUDE.md`, ADRs in `docs/decisions` or `docs/adr`, `GLOSSARY.md`, `.claude/journal` and `CODEOWNERS`.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install project-brain@claude-mods
```

## Usage
- **Automatic recall.** Each prompt you type may get a hidden context note of up to ~600 tokens, for example `- lesson 2026-10-07: Fix for "AssertionError: expected 4199 to be 4200" (npx vitest run): changed src/cart.ts (fix for npx vitest run: AssertionError…) [l3k9x]`. Each memory is told once per conversation, and again only if it comes back strongly much later. Rules already in `CLAUDE.md` are never repeated, because they are in the system prompt already.
- **Tools for Claude.** `brain_recall({ query, limit? })` searches the memory the same way. `brain_remember({ text, kind })` saves a fact (`decision`, `convention`, `lesson`, `term`, `person`, `task` or `note`) and links it to the files in play.
- **`/brain`** opens the **Brain** panel. With mods-hub installed it is a tab of the Claude Mods panel; without the hub it opens in a pane of its own. The panel has:
  - **Active now**: the memories that fired on the last recall, each with an activation bar (`████████░░ 0.82 decision: …`).
  - **Neighbourhood**: a text graph of the strongest links around the top memory, or around the one you pick with **[graph]**. `━━` is a strong link, `──` a medium one, `┄┄` a weak one.
  - **Memories**: search, then **[pin]** (keep it at full strength; also a positive sample for the ranker), **[edit]**, **[forget]** (a negative sample; automatic learning will not bring it back) and **[graph]**.
  - **Stats**: memories, links, the ranker's samples and recent accuracy, and the last consolidation.
- `/brain search <words>`, `/brain remember <text>`, `/brain pin|unpin|forget <id>`, `/brain sleep` (consolidate now), `/brain stats`, `/brain import` (re-read the knowledge files).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `inject` | boolean | `true` | Add recalled memories to your prompts. Off, the brain still learns, and the tools and panel still work. |
| `tokenBudget` | number | `600` | Most tokens one recall note may add (about 4 characters each). |
| `useModel` | boolean | `true` | Background extraction of decisions, conventions and lessons from finished turns, plus cluster summaries while idle. |
| `model` | string | `haiku` | Model for that background work. |
| `modelCallsPerHour` | number | `6` | Rate limit for those calls (0 turns them off). |
| `halfLifeDays` | number | `14` | A link that is not used loses half its strength in this time. |
| `maxNodes` | number | `4000` | Memory cap per project (up to 6000; links are capped at ten times this). |
| `idleMinutes` | number | `10` | Minutes without a prompt before the brain consolidates. |

## How it works
- **Prompt budget.** The tool descriptions are kept short; `brain_recall` is registered only once the brain holds a memory (after the import, or the first `brain_remember`).
- **Graph and learning.** Nodes carry embedding-free features: English and Italian stems, bigrams, paths and symbols. Nodes that fire together in a turn (edited files, symbols, errors, used memories, new statements) strengthen their links Hebbian-style, Δw = η·aᵢ·aⱼ·(1 − w). Unused links decay exponentially with the half-life. Salience rises when a memory is recalled *and* used. **Recall** seeds nodes by BM25 overlap and by identity (the files in play, recent errors). Activation then spreads 3 hops, fading at each hop and normalised by fan-out, and only the 48 most active nodes survive each hop (lateral inhibition).
- **Ranking and sleep.** Each candidate gets 16 inputs: activation, lexical match, salience, recency, freshness, path strength, hops, past usefulness, ignored streak, degree and kind. A 16→8→1 MLP (tanh, sigmoid) scores them, trained online by SGD with L2 from deterministic weights. A memory counts as *used* when the answer or the edits reference it, and as *ignored* when it was told twice for nothing. Until 30 such samples a hand-written score ranks alone; the network then blends in and takes over fully at 60. **Sleep** runs after 10 idle minutes, on hub `session.idle`, at session end and on `/brain sleep`. It merges near-duplicates, prunes faded links and weak memories, enforces the cap, and summarises clusters with the model. Heavy work always runs off the prompt path.
- **Hub and privacy.** With mods-hub, the brain reads `decision.recorded`, `lesson.learned`, `error.repeated`, `test.result` and `git.commit` from the bus (pulled every minute and after each turn), publishes `x.project-brain.recalled` and `x.project-brain.updated`, and shares the facts `project-brain.stats` and `project-brain.top`. Without the hub it works the same, minus those. Every stored text goes through the shared secrets masker. Edits contribute only paths and declared symbol names, never file contents; errors keep one line. Several sessions on one project merge their saves. Commit `.claude/brain/` to share the memory with your team, or add it to `.gitignore` to keep it private. Limits: recall is lexical plus associative, with no semantic embeddings. Without mods-hub, other mods' decisions reach the brain only through the files they write (ADRs, journal).
