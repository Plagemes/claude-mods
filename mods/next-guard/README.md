# next-guard
> Flags missing or needless "use client" and server-only imports leaking into client components in Next.js.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
In a Next.js App Router project (a `package.json` that lists `next`), every time Claude edits or writes a file in `app/` or `src/app/`, next-guard reads it and tells Claude about three things: a component that uses `useState`, `useEffect`, event handlers such as `onClick`, or browser APIs but has no `"use client"`; a `"use client"` file that imports server-only modules (`fs`, `server-only`, `next/headers`, database clients, local `db`/`server` modules); and a `"use client"` file that uses nothing client-side, where the directive can go.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install next-guard@claude-mods
```

## Usage
Nothing to run. You see a toast such as `1 'use client' note for counter.tsx`, and Claude gets the details:

```
next-guard: 2 notes on /repo/app/cart/page.tsx:
  warn: uses useState, onClick but has no 'use client'; in the App Router this file is a Server Component, so it fails. Add 'use client' as the first line, or move the interactive part into a client component
  warn (line 3): a 'use client' file imports next/headers, which only works on the server; ...
```

It also notes `error.tsx` and `global-error.tsx` without `"use client"`, and `metadata` exports in a client file. Hooks that work in Server Components (`useMemo`, `useCallback`, `useId`, next-intl's `useTranslations`) and `typeof window` checks are not counted. Route handlers, `middleware` and `"use server"` files are skipped.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `hintUnneeded` | boolean | `true` | Also hint when a `"use client"` file shows no client-only feature. The hint is skipped when the file imports a third-party package, which may need the client. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`. After a successful change inside `app/` or `src/app/` it finds the project's `package.json` (once per project) and, if `next` is listed, reads the edited file and analyses it; it never blocks anything.
- The analysis reads text: comments are removed and strings blanked, then it looks for hook calls, `on*={...}` handlers, `window`/`document`/`localStorage`, `createContext`, class components and `ssr: false`, plus the import list.
- Limits: it looks at one file, so it cannot see that a component is only ever used from a client component (where the missing directive is harmless), what a third-party package needs, or code reached through a re-export. Treat the notes as pointers, not verdicts.
- With [mods-hub](../mods-hub) installed: the greeting says it publishes `lint.result` (`tool: next-guard`, the real problems as `warnings`; a note that is only a needless-`'use client'` hint publishes nothing), and the toast goes through `notify` (`warning`, or `info` for hints only) so it can follow you to your phone while you are away. Without the hub nothing changes. Line numbers come from the shared `line-index` library.
