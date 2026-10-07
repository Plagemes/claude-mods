# glossary
> Teaches Claude your project's vocabulary and injects definitions when you use the terms.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Every team has words that mean something specific: a "tenant", the "widget queue", the "ledger". This mod reads your project's glossary and, when a prompt mentions one of those terms, quietly attaches its definition for Claude. Claude uses your meaning instead of guessing, and you never paste definitions again.

## Install
```
/plugin install glossary --marketplace plagemes/claude-mods
```

## Usage
- Put terms in any of these (all optional, merged, earlier wins on duplicates):
  1. `/define <term> = <meaning>`, stored per project on this machine
  2. `.claude/glossary.json`: `{ "term": "meaning" }`, `{ "terms": { ... } }` or `[{ "term", "definition" }]`
  3. `GLOSSARY.md` at the project root: bullets (`- **Term**: meaning`, `- Term — meaning`), bold lines, two-column tables, `## Term` over a paragraph, or `Term` followed by `: meaning`. `Bounded Context (BC)` matches both names.
- Then just write prompts. While a prompt carries definitions, the status line shows `📖 glossary: Tenant` (or `📖 glossary: 3 terms`).
- `/define <term>` shows a term you defined; `/glossary` lists every term and its source; `/glossary remove <term>` deletes a `/define` term.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxTermsPerPrompt` | number | `12` | The most definitions attached to one prompt. |
| `repeatDefinitions` | boolean | `false` | Attach a definition every time the term appears, not only the first time in a conversation. |

## How it works
- Hooks `prompt.submit` and adds one hidden context block (`Project glossary — definitions of terms used in this message`) that the model reads and you never see. Matching is case-insensitive on whole words and allows a plural `s`/`es` (`tenants` matches `Tenant`, `skunkworks` does not match `SKU`). Slash commands are left alone.
- Each definition is sent once per conversation, then again after `/clear` or a compaction, or whenever you change it.
- Glossary files are parsed again only when their modification time changes. `/define` terms live in the mod's `$.store`, so they stay on your machine; commit `GLOSSARY.md` or `.claude/glossary.json` to share terms with the team.
