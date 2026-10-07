# prompt-enhancer
> /enhance rewrites your draft prompt into a precise, well-scoped request.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
Type a rough idea after `/enhance` and a model rewrites it into a clear request for Claude Code: the goal up front, the scope, acceptance criteria it can infer, and any assumption spelled out, with every concrete detail you gave kept and nothing invented. It knows your project's name, stack, test script and top-level layout, so the rewrite names the right tools. You review original and rewrite side by side before anything is sent.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install prompt-enhancer@claude-mods
```

## Usage
- `/enhance fix login its broken since the refactor` opens the **Enhance prompt** pane and rewrites the draft.
- `/enhance` with no text enhances whatever is in the prompt box.
- In the pane:
  - **Use** (`u`) puts the rewrite in the prompt box, replacing the draft, for you to edit.
  - **Send** (`s`) submits it as your prompt.
  - **Retry** (`r`) asks for another rewrite; **Copy** (`c`) copies it; **Discard** (`x`) closes the pane.
- While it works you can keep typing; **Cancel** stops it. A failure says why (for example `the API answered 529 (overloaded)`) and offers **Retry**.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `sonnet` | The model that rewrites drafts: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |
| `includeContext` | boolean | `true` | Send the project's name, detected stack, test script and top-level file names along with the draft. |

## How it works
- `/enhance` opens the pane and starts one `$.model.complete` call (no tools, no conversation history) with a fixed rewriting system prompt, off the command's own dispatch so the prompt stays usable; it times out after 60 seconds.
- Project context comes from the root directory listing and `package.json` (dependencies, test script); no file contents are sent besides that.
- The rewrite uses your account like any other request, and is billed as one small completion.
