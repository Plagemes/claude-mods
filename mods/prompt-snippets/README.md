# prompt-snippets
> Type :review:, :tests: or your own shortcodes and they expand into full prompts.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Write `:review:` anywhere in a prompt and it is replaced by a full, well-phrased instruction before Claude sees it, so `:review: focus on src/auth.ts` becomes a complete review request. Seven snippets ship built in (`review`, `tests`, `explain`, `refactor`, `docs`, `perf`, `security`), and you can add your own.

## Install
```
/plugin install prompt-snippets --marketplace plagemes/claude-mods
```

## Usage
- `:name:` in a prompt expands to the snippet. Unknown names (`:smile:`) and things like `10:30:45` are left alone; put a shortcode in backticks to keep it literal.
- `/snippets` lists every snippet with its source (`built-in`, `config`, `custom`) and a preview.
- `/snippet-add <name> <text>` saves a custom snippet, kept across sessions. `/snippet-remove <name>` deletes one.
- Precedence: your `/snippet-add` snippets beat the `snippets` setting, which beats the built-ins.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `snippets` | `{}` | JSON object of shortcode to prompt text, e.g. `{"ship": "Run the tests, then commit."}`. Names: letters, digits, `-`, `_`. |

## How it works
- A `prompt.submit` hook rewrites the text of prompts you type (not prompts from plugins, peers or notifications). Expansion is a single pass: a snippet that contains another `:token:` is not expanded again.
- Custom snippets live in `$.store`, so they survive restarts.
- Matching is case-insensitive. An expanded prompt is what appears in the transcript and what the model reads.
