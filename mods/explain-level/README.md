# explain-level
> /eli5, /normal and /expert set how deep Claude's explanations go.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Three commands set the depth of Claude's explanations for the session. `/eli5` asks for plain words, small steps and everyday analogies; `/expert` asks for dense, precise answers that skip the basics and spend the words on trade-offs and edge cases; `/normal` goes back to the default. Code, commands and file paths stay exact at every level.

## Install
```
/plugin install explain-level --marketplace plagemes/claude-mods
```

## Usage
```
/eli5     explain like I'm new to this
/expert   assume I know the basics, go deep
/normal   back to the usual depth
```
While the level is not normal, the status line shows `explain: eli5` or `explain: expert`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `startLevel` | `eli5`, `normal` or `expert` | `normal` | The level every session starts at. |

## How it works
- Keeps the level in `$.state`, so it survives a plugin reload within the session.
- Hooks `prompt.compose` and appends an `explain-level:depth` section for `eli5` and `expert`; at `normal` it adds nothing, and a `--bare` session is left alone.
- Registers the three commands at session start; each confirms the new level and updates the status line.
- Limits: it steers how the model explains, it does not rewrite earlier answers. Changing level changes the system prompt once, which costs a single prompt-cache miss.
