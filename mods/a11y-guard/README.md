# a11y-guard
> Flags accessibility misses as Claude writes UI: images without alt, unlabeled buttons, clickable divs.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
After Claude edits or writes a `.jsx`, `.tsx`, `.vue`, `.svelte`, `.html` or `.astro` file, a11y-guard looks at the markup the edit adds and lists the accessibility misses: `<img>` without `alt`, icon-only `<button>` and `<a>` with no text or `aria-label`, `onClick` on a `<div>` or `<span>` without a role, `tabIndex` and a key handler, `<input>`, `<textarea>` and `<select>` with no label, positive `tabIndex`, and `autoFocus` outside a dialog. Problems that were already in the file are not blamed on the new edit.

## Install
```
/plugin install a11y-guard --marketplace plagemes/claude-mods
```

## Usage
In the default warn mode the edit goes through, you get a toast (`3 accessibility issues in Gallery.tsx`) and Claude reads a note it can act on:

```
a11y-guard: this edit to /app/src/Gallery.tsx adds 3 accessibility issues:
- line 4: <img> has no alt attribute: add alt text, or alt="" when the image is decorative
- line 5: <button> has no text or aria-label (icon-only?): give the button text or an aria-label
- line 6: <div> has a click handler but is missing role, tabIndex and a key handler: use a <button> instead
Fix them in a follow-up edit.
```
In block mode the same list is returned as a refusal and the edit does not happen.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | `warn` | `warn` lets the edit through and tells Claude; `block` refuses it until the markup is accessible. |

## How it works
- Hooks `tool.call` for `Edit` and `Write`. It reads the file, replays the edit on it (a `Write` compares with the old content), scans the tags of both versions and reports the issues whose element is new. If an `Edit` cannot be replayed, the old and new snippets are compared instead. In block mode it judges before the tool runs; it never blocks because of its own failure.
- It reads native lowercase elements only (`<img>`, `<button>`, `<input>`, ...). Components like `<Button>` or `<Image>` are skipped, and an element with a spread (`{...props}`, `v-bind="x"`) is not judged on attributes that might arrive through it. A computed `id` (`useId()`) gets the benefit of the doubt for labels.
- Limits: it is a markup scanner, not a browser. Names that come from CSS, from a parent `<label>` in another file or from a component's own props are invisible to it; `autoFocus` counts as fine when the file mentions a dialog, modal, popover, drawer or sheet.
