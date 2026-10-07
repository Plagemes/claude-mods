# ticket-linker
> Turns ticket references like ABC-123 or #42 into links and context for Claude.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
When your prompt mentions a Jira-style key (`ABC-123`) or a GitHub issue number (`#42`), ticket-linker appends one line with the matching URLs, so Claude can open the ticket instead of guessing what it is. The `#42` links point at the GitHub repository your git remote names, so a prompt typed inside a checkout just works.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install ticket-linker@claude-mods
```

## Usage
Type your prompt as usual. With `jiraBaseUrl` set to `https://acme.atlassian.net`, the prompt `Fix ABC-123, see #42` reaches Claude as:
```
Fix ABC-123, see #42

Referenced tickets: ABC-123 (https://acme.atlassian.net/browse/ABC-123), #42 (https://github.com/acme/app/issues/42)
```
Acronyms such as `UTF-8` or `SHA-256`, links already written out, fenced code, and three- or six-digit numbers on a line about colours (`#333`) are not treated as tickets. Slash commands are left alone.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `jiraBaseUrl` | string | empty | Your Jira address, for example `https://acme.atlassian.net`. Empty means Jira-style keys are ignored. |
| `jiraProjects` | string | empty | Comma-separated keys to recognise, for example `ABC,WEB`. Empty accepts any `KEY-123` that is not a well-known acronym. |
| `githubRepo` | string | empty | `owner/name` that `#123` refers to. Empty reads it from the `origin` git remote. |

## How it works
- Hooks `prompt.submit` and, for your own prompts only, appends a `Referenced tickets:` line to the text. You see the line in the transcript, so nothing is added behind your back. At most eight tickets are listed.
- The repository comes from `$.session.repo()`; only GitHub remotes (SSH or HTTPS) are understood, so `#42` is left alone for other hosts unless `githubRepo` is set.
- Limits: it links, it does not fetch ticket contents. A bare number like `#42` is always read as a GitHub issue, which is a guess in a repository whose tracker lives elsewhere.
