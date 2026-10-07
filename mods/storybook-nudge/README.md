# storybook-nudge
> Reminds you to add a story when Claude creates a new component without one.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
In a project with Storybook (a `.storybook/` folder), storybook-nudge notices when Claude writes a brand-new component file: a PascalCase `.tsx`, `.jsx`, `.vue` or `.svelte` file under a `components/` folder. When the turn ends and no `*.stories.*` file sits next to it, you get a toast and a band above the prompt with a button that asks Claude to write the story.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install storybook-nudge@claude-mods
```

## Usage
After the turn that created `src/components/Button.tsx` you see the toast `Button.tsx has no story yet` and a band:

```
Storybook  Button.tsx has no story
[ Ask Claude to add stories ]  [ Dismiss ]
```
`s` or a click on the first button sends Claude a prompt listing the components and the story file each should get (`Button.stories.tsx`), asking it to follow the stories you already have. `d` or Dismiss hides the band. The band also goes away on its own when a story for that component is written later.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directories` | string | `components` | Comma-separated folder names; a new component inside one of them, at any depth, is expected to have a story. |

## How it works
- Hooks `tool.call` for `Write` to see new component files (the file did not exist, and a `.storybook/` folder is in its folder or above it, up to the project root, so packages in a monorepo work) and new `*.stories.*` files; hooks `turn.complete` of the main loop (not subagents, not interrupted turns) to look for a story; draws the band on `AbovePrompt`, composed with other plugins' bands. What is waiting for a story is kept in `$.state`, so a reload does not lose it.
- A story counts when `<Name>.stories.*` or `<Name>.story.*` is next to the component or in a `stories/` or `__stories__/` folder beside it. It never blocks or writes anything itself; the button only submits a prompt as you.
- Limits: stories kept elsewhere (a global `src/stories/` folder, other globs in `.storybook/main.ts`) are not found, so those components are nudged anyway (Dismiss); components created by shell commands or generators rather than `Write` are not seen.
