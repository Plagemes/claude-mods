# react-doctor
> Catches React hook mistakes as Claude writes them: missing effect deps, setState in render, conditional hooks.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
Each time Claude edits or writes a `.jsx` / `.tsx` file (or a `.js` / `.ts` file that imports React), react-doctor checks the components and hooks the edit touched. It finds hook mistakes the code review usually catches too late. The problems go straight back to Claude in the edit's result, with `file:line`, so they get fixed in the same turn.

| Finds | Example |
| --- | --- |
| Hooks called conditionally, in loops, in callbacks or after an early return | `if (id) { useEffect(…) }`, `items.map(i => useThing(i))` |
| Effect, memo and callback dependencies that are missing | `useEffect(() => load(userId), [])` → missing `userId`. Setters, dispatch and refs are known to be stable. |
| `useMemo` / `useCallback` with no dependency array | `useMemo(() => expensive(a))` |
| `setState` while rendering | `setCount(count + 1)` in the body, `onClick={setOpen(true)}` |
| Elements returned from `.map()` with no `key` | `rows.map(r => <li>{r}</li>)`, or a `<>…</>` fragment |
| Async effects | `useEffect(async () => …)` |

## Install
```
/plugin install react-doctor --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. After an edit with problems, Claude's tool result carries a note like:
```
react-doctor found React issues in src/Profile.tsx:
- src/Profile.tsx:12 useEffect in Profile is missing dependencies: userId, onLoad
- src/Profile.tsx:31 <li> returned from .map() has no key prop
Fix them, or say why one is intentional.
```
Each issue is reported once. It is reported again only if it comes back after a fix.

The status line shows the open issues: `⚛ 2 React issues · Profile.tsx`. It clears when they are fixed.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `useEslint` | boolean | `true` | Use the project's ESLint for the hook rules when `eslint` and `eslint-plugin-react-hooks` are installed. |

## How it works
- A `tool.call` hook on `Edit` and `Write` reads the file after a successful edit. For an Edit, it checks only the components and hooks that contain the new text, plus `.map()` calls in that range.
- The built-in check is a lightweight scanner, not a full parser. It blanks comments, strings and JSX text, matches brackets, finds components (capitalized functions, `memo` and `forwardRef` included) and custom hooks (`use…`), then applies the rules above.
- When the project has `node_modules/.bin/eslint` and `eslint-plugin-react-hooks`, it runs `eslint --format json --rule 'react-hooks/rules-of-hooks: error' --rule 'react-hooks/exhaustive-deps: warn' <file>` (20 s timeout) and uses those findings for the hook rules. It keeps its own checks for setState in render, keys and async effects. If ESLint's config doesn't load the plugin, or ignores the file, the built-in check is used instead.
- Limits:
  - The scanner can't follow values across files or through custom hooks the way the React Compiler does. Dependencies are matched by name: listing `props.user` covers `props.user.id`.
  - The ESLint run adds a moment to each React edit. Turn `useEslint` off if that matters more than the exact rule set.
