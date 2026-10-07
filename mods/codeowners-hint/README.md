# codeowners-hint
> Shows who owns a file (from CODEOWNERS) as Claude edits it.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Before Claude edits or writes a file, codeowners-hint looks the file up in your CODEOWNERS and puts the owners in the status line, so they are on screen while you approve the change: `owners: @org/backend @alice (users.ts)`. `/owners <path>` answers the same question for any path and shows which rule matched.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install codeowners-hint@claude-mods
```

## Usage
- Automatic: the status line shows the owners of the file Claude is editing, and clears when a new turn starts or when nothing owns the file.
- `/owners <path>` prints `📋 api/users.ts is owned by @org/backend @alice` and the rule that matched (`rule: /api/ (.github/CODEOWNERS:4)`). Without a path it uses the last file Claude edited. A relative path is read from the session's directory.

## Configuration
No configuration needed.

## How it works
- Reads CODEOWNERS from `.github/`, the repository root or `docs/` (the first one found, as GitHub does), re-reading it only when it changes. Patterns follow GitHub's rules: gitignore-style, the last matching rule wins, a rule with no owners clears ownership, `/dir/` owns everything beneath it, `docs/*` reaches one level only, `**` crosses directories.
- Hooks `tool.call` for Edit and Write (status line, before the edit runs) and answers `/owners` through `command.run`; any failure to read or parse the file is swallowed so edits are never held up.
- Limits: it supports the GitHub dialect only (no GitLab sections or character ranges), and it only shows owners, it does not enforce anything. Paths outside the git repository have no owners.
