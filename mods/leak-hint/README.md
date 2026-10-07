# leak-hint
> Flags event listeners, intervals and subscriptions created without cleanup.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
After Claude edits or writes a JavaScript, TypeScript, Vue or Svelte file, leak-hint scans it for things that are started and never stopped: a `useEffect` that adds a listener, interval, timeout or subscription but returns no cleanup, a class that starts them in `componentDidMount` or `ngOnInit` with no matching removal in `componentWillUnmount` or `ngOnDestroy`, a Vue `onMounted` with no unmount hook, and Node request handlers that register `process.on` or another outer emitter's listener on every request. Only leaks that the edit brought in are reported, with a toast for you and a note for Claude.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install leak-hint@claude-mods
```

## Usage
Nothing to run. When an edit introduces a leak you see a toast like `possible leak in Chart.tsx:3: useEffect adds a "resize" listener but returns no cleanup function…`, and Claude is told:

```
leak-hint: this edit to /app/src/Chart.tsx may have introduced a leak (found by pattern, so check it):
- line 3: useEffect adds a "resize" listener but returns no cleanup function; it should call removeEventListener when the effect ends.
If it is real, add the cleanup now; if the listener has to live as long as the page, say so in a comment.
```

Test files (`*.test.*`, `*.spec.*`, `__tests__`), `node_modules`, build output and `.d.ts` files are never checked.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `ignore` | string | empty | Regular expression. Files whose path matches are never checked (for example `legacy/`). An invalid regex is ignored. |

## How it works
- Hooks `tool.call` for `Edit`, `Write` and `MultiEdit`. It reads the file before and after the edit, scans both, and reports only findings that were not there before, so an old leak is not repeated every time the file is touched. The edit is never blocked.
- The scan is textual: it blanks comments and strings, then matches `useEffect`/`useLayoutEffect`/Svelte `onMount`, classes (setup methods against `componentWillUnmount`, `ngOnDestroy`, `disconnectedCallback`, `dispose`, ...), Vue lifecycle hooks and handlers whose first parameter is `req`, `request` or `ctx`. Timers started in a nested callback (an event handler, say) are not counted, and timeouts are only reported inside effects.
- Limits: it is a heuristic, not a data-flow analysis, so it can miss leaks (a listener added inside a `.then`, a cleanup defined elsewhere) and can flag code that is fine (a helper that removes the listener for you). Files over 400,000 characters are skipped.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: leak-hint`, the file, and how many findings) after each edit with findings and sends its note through `notify` (level info) instead of a toast. Without the hub nothing changes; the mod stands alone.
