# decision-log
> /decide records an Architecture Decision Record in docs/decisions.

**Category:** Memory & Knowledge · **Version:** 1.0.0

## What it does
Once you and Claude have talked a decision through, `/decide <title>` turns that conversation into an Architecture Decision Record (Context, Decision, Consequences, Alternatives considered). It shows the draft in a pane, and **Save** writes it as the next numbered file, e.g. `docs/decisions/0007-use-postgres-for-events.md`. `/decisions` lists the ones you already have.

## Install
```
/plugin install decision-log --marketplace plagemes/claude-mods
```

## Usage
- `/decide Use Postgres for event storage` opens the **ADR** pane (`⏳ Drafting ...`, then the rendered preview and the target file name).
  - **Save** (`s`) writes the file and shows `✅ Saved docs/decisions/0007-....md`.
  - **Regenerate** (`r`) drafts again; **Discard** (`d`) closes the pane.
  - If there is nothing to draft from (a fresh session, right after `/clear`) or the model fails, the pane says why and offers **Retry**.
- `/decide` with no title reopens an unsaved draft.
- `/decisions` prints one line per ADR: `0003. Use Kafka (Superseded, 2026-03-02)`.

Files look like:
```markdown
# 0007. Use Postgres for event storage

- Status: Accepted
- Date: 2026-10-07

## Context
...
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | string | `docs/decisions` | Folder for ADRs, relative to the project root. |
| `status` | `Accepted` \| `Proposed` | `Accepted` | Status written into new ADRs. |

## How it works
- `/decide` calls `$.model.fork`, which asks one tool-less question over this session's own transcript (served from the prompt cache), so the ADR reflects what was actually discussed. It is told to write "TBD" rather than invent facts; review it before saving.
- The draft lives in `$.state` and is drawn in a `Pane` with `Markdown` and `Button` elements (terminal and desktop).
- Numbers come from the highest `NNNN-*.md` in the folder, re-checked at save time so two drafts never collide; `/decisions` reads each file's heading, `Status:` and `Date:` lines (MADR front matter works too).
