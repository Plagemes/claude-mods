# smart-router
> Routes every subagent to the right model for the task's difficulty, runs independent work in parallel and starts workflows when a job needs one.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Every time a subagent starts (from Claude's Agent tool, another plugin or a workflow), smart-router reads its task, rates it **light**, **standard** or **deep** (English and Italian rules, your corrections first), and sets its model: haiku, sonnet or opus by default. A short system-prompt section teaches Claude when to work inline, when to hand work to one agent, when to fan out parallel agents in one message, and that a workflow needs your explicit OK. `/route <task>` drafts a plan with stages, tiers and a cost forecast, with buttons to run it. The **Router** pane shows live agents, what routing saved against running everything on the main model, every decision, and what it has learned.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install smart-router@claude-mods
```

## Usage
- **Status line:** `⇄ router: 3 haiku · 2 sonnet · 1 opus` (subagents this session, by the model they ran on).
- **`/router`** opens the Router pane (a sidebar on a wide terminal). `/router auto|suggest|off` switches the mode, `/router reset` clears the stats. Sections fold with `1`–`5`:
  - **Header:** mode chips **Auto / Suggest / Off** (`a` `s` `o`), profile chips **Saver / Balanced / Fast / Max quality** (`v` `n` `f` `q`), `Saved $1.84 (-62%)`, spend and agent count.
  - **Live now:** running subagents with their model, elapsed time and tool calls; sampled **quality checks** (`u` Review with a stronger model, Skip).
  - **Mix:** stacked bars of calls and tokens per model, cost per model, a saved-per-turn sparkline, prompt-cache reuse, and the project's **opus share** gauge.
  - **Decisions:** the last 50, newest first: tier glyph (◔ light, ◑ standard, ● deep), model, task, reason tag (`explore`, `design`, `retry↑`, `budget↓`, `explicit`, …). Select one for the prompt excerpt, matched signals, the reason, its cost against the main model, and **Should be light / standard / deep** (`l` `m` `d`, learns a rule) and **Copy prompt** (`y`).
  - **Plan:** the last `/route` plan: stages (side by side when the pane is wide), tiers, files each subtask writes, the recommended mode and why, the cost of each way to run it, and **Run in parallel** (`p`), **Run as workflow** (`w`, only when rule B4 holds), **Copy plan** (`c`), **Discard** (`x`); for work best done inline, **Main → sonnet** switches the main model, only when pressed.
  - **Rules & settings:** Protect deep (`g`), budget bias (`b`), max parallel `−`/`+`, learned rules (Delete), reliability per kind of task, **Reset stats** (`r`).
- With [mods-hub](../mods-hub) installed, the Router is the **Router** tab of the shared Claude Mods panel (`/router`, `/route` and `autoOpen` open it there); its sections fold with their buttons, since the panel's tab strip owns the digit keys.
- **`/route <task>`** asks the light model to split the task into JSON subtasks `{title, tier, prompt, dependsOn, writes}`, then plans stages and the run mode by the rules below. **Run in parallel** sends Claude, as your own words, the plan with a model per subagent; **Run as workflow** sends an explicit opt-in to the Workflow tool.

## Routing rules
**A. Tier per task** (the classifier; a learned rule wins over everything)
- **light → haiku:** read-only exploration (search, grep/glob, list, read and summarise, find where something is defined or used), docs lookup, running a command and reporting its output, extracting or reformatting data, mechanical edits with exact instructions (rename, apply a diff, format, bump a version), boilerplate from an existing template. The built-in **Explore** agent is light (standard at most).
- **standard → sonnet** (the default when unsure): a feature with a clear spec, writing or fixing tests, a bug with a reproduction, a refactor within one module (≤ 5 files), reviewing a small diff, writing docs, following an existing pattern.
- **deep → opus:** architecture and trade-offs, ambiguous requirements, cross-cutting changes (> 5 files or modules, public APIs), security review, concurrency / performance / memory root causes, production or irreversible work (data migrations, deploy scripts, auth, crypto), merging parallel agents' results, anything that failed twice. The built-in **Plan** agent is deep. A subject alone (auth, production, architecture) does not make a lookup or a test-writing task deep.
- **Up a tier:** a retry after a failed or empty run (twice failed → deep; never the same tier twice); the same prompt again within 5 minutes of a success (once); a fresh test regression (the next change); a kind of task with low reliability in this project (see Outcome learning).
- **Down a tier:** 3 successes in a row of one kind (never below light, never for deep categories); past the **budget bias** spend, or (with mods-hub) once another mod reports a budget 80% used (`budget.threshold` from token-budget or daily-spend), borderline tasks; past the **opus quota**, borderline deep tasks. Each move is logged with its reason.
- **Never:** a model the caller set (unless `override` is `always`), a fork, a teammate, or a custom agent type (its definition may pin a model; `override: always` routes them). Deep work never runs below the main model while **Protect deep** is on. Effort is never set, unless the **effort lever** is on.

**B. Inline, one agent, parallel or workflow** (the system-prompt guidance and the planner)
1. **Inline:** about 3 tool calls or fewer, work that needs the conversation's details, one small edit.
2. **One subagent:** a self-contained, read-heavy chunk that would flood the context; usually light, with a concise summary back.
3. **Parallel subagents:** 2–`maxParallel` independent subtasks in ONE message; more are batched; two that write the same files are serialized (or given `isolation: "worktree"`); one verification step after parallel writes. Parallel prompts start with the same shared context block so the prompt cache is reused; many tiny same-kind light chores go to one agent as a list.
4. **Workflow:** only with your explicit opt-in (you asked for one, pressed **Run as workflow**, or said "ultracode") **and** a big or structured job: ≥ `workflowThreshold` subtasks, a multi-stage pipeline with a fan-out, or more than 10 agents. Otherwise Claude proposes it with a rough cost and waits.
5. **In order:** dependent subtasks run in sequence; independent ones inside a stage run in parallel.
6. The main thread coordinates: plan, dispatch, integrate, verify.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` sets models; `suggest` only logs; `off` does nothing. |
| `profile` | `balanced` | `saver` (opus quota 20%, budget bias $2, 3 parallel, 5% audits), `balanced` (these settings), `fast` (haiku/sonnet/sonnet, 8 parallel, no audits), `max` (sonnet/opus/opus, 25% audits). |
| `lightModel` / `standardModel` / `deepModel` | `haiku` / `sonnet` / `opus` | Model per tier: an alias, a full id, or `inherit` (the main model). |
| `override` | `never` | `always` also routes calls with an explicit model and custom agents. |
| `protectDeep` | `true` | Deep work never runs below the main model. |
| `budgetBias` | `5` | USD of session spend past which borderline tasks go a tier down; `0` off. |
| `opusShare` | `0` | Soft cap (%) on the project's subagent tokens on opus-class models; `0` off. |
| `auditRate` | `10` | % of finished light/standard agents that changed files offered a review one tier up. |
| `useEffort` | `false` | Run well-scoped deep tasks (a race, a leak, a slow path in ≤ 3 files) on the standard model at effort high. |
| `useModel` | `false` | Ask the light model about borderline tasks (5 tokens, 4 s, cached). |
| `maxParallel` | `5` | Most subagents per parallel batch (1–8). |
| `workflowThreshold` | `6` | Subtasks from which a plan can run as a workflow. |
| `prices` | `""` | JSON overrides, `{"<model id part>": {"input": 3, "output": 15}}` (USD per million tokens). |
| `autoOpen` | `false` | Open the pane when a session starts (docked only from 144 columns). |
| `writeFiles` | `true` | Keep `daily.json` and `stats.json` (below) up to date. |

The pane's chips and toggles change the current session only; the configuration is the default for every session.

## How it works
- **`agent.spawn`** classifies each spawn and, in `auto`, rewrites its `model` (an alias such as `haiku`). A workflow script's agents fire this event too, but the engine does not let a hook change their content: smart-router only logs the model it would pick, and the guidance tells Claude to set `opts.model` per `agent()` in the script. **`prompt.compose`** adds one session-scope section (stable for the prompt cache; it changes only when you change mode, profile or max parallel). **`turn.complete`** prices every turn with the price table every Claude Mod shares (`shared/prices.ts`, API list prices; an estimate on Bedrock, Vertex or a plan), compares each subagent's cost with the main model's, and records its outcome.
- **Outcome learning** (per project, in the plugin's store): a decaying reliability score per kind of task × tier from errors and empty answers, same-prompt redos, a failing `npm test`/`pytest`/`go test`/… run within 15 minutes after an agent's edits, your "Should be …" corrections to a higher tier, and quality-check verdicts (`AUDIT: PASS|FAIL`). Two failures pull a kind below 50% and route it a tier up; the weight of a failure halves every week. Signals from other mods: without mods-hub, smart-router derives them itself from usage and Bash test results; with it, it also reads the bus (below).
- **With mods-hub:** each routing decision is published as `agent.routed`, each finished subagent as `agent.finished` (outcome, duration, cost) and its cost as `cost.update` (the hub's own `cost.update` covers the main conversation); the routing settings in force are shared as the fact `smart-router.policy` (mode, profile, models per tier, max parallel, protect deep, budget bias, opus quota), updated when you change them. Before each spawn it reads the latest `budget.threshold` and the `test.result` events other mods published (test-watch's own runs; the hub's mirror of Bash runs is skipped, they are counted already), so a failing test-watch run after a pass counts as a regression. Quality-check verdicts go through the hub's notifications. Without the hub everything above works as described.
- **The effort lever** rewrites the Agent tool call (`tool.call`) to `effort: "high"` before it spawns, then routes it to the standard model. Agents started by plugins or workflows never get effort. **The main-model switch** is a button that runs `/model <alias>`; nothing switches it on its own.
- **Summary files** for other mods, in `~/.claude/claude-mods/smart-router/`, written 5 s after changes and at session end: `daily.json` — `{ "date": "YYYY-MM-DD", "saved": USD, "spent": USD, "byModel": { "haiku": { "calls", "tokens", "usd" }, … } }`, today's totals across sessions (`spent` is every turn's cost, `saved` the subagents' savings against the main model); `stats.json` — this session: `{ version, updatedAt, project, mode, profile, mainModel, agents, spent, subagentSpent, saved, byModel, cacheReuse, opusShare, weakSpots }`.
- **Limits:** the classifier reads words, so a vague prompt lands on standard; correct it once and the rule sticks for the project. `/route`'s planner sees only your words, not the code. Cost forecasts use typical token counts per tier, not a measurement. Running agents show tool calls, not tokens (tokens arrive when they finish). Escalation and streaks are kept per session load.
