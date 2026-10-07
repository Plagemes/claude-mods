# url-allowlist
> Restricts WebFetch to the domains you allow.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
url-allowlist checks the host of every WebFetch Claude makes. In the default allow mode only the hosts on your list (documentation sites, GitHub, npm, PyPI, Stack Overflow and the like) and their subdomains can be fetched; anything else is refused with a message that tells Claude to ask you. Look-alikes such as `github.com.evil.com` or `https://github.com@evil.com/` do not pass. You can allow a host for the rest of the session with `/allow-host`, or switch to block mode and list only what to refuse.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install url-allowlist@claude-mods
```

## Usage
When a fetch is refused you see a toast (`blocked fetch from example.com. /allow-host example.com allows it for this session`) and Claude reads `url-allowlist: example.com is not on the allowlist, so this WebFetch was blocked. Ask the user to run /allow-host example.com ...`.

```
/allow-host docs.example.com        allow it and its subdomains for this session
/allow-host remove docs.example.com
/allow-host clear                   forget what was added this session
/allow-host                         show the mode and both lists
```
Only you can run it: a command that arrives from a plugin or from Claude is refused. `localhost`, `127.0.0.1` and `::1` are always allowed. A name with no dot (`com`) is not accepted as a host.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | `allow` | `allow`: only listed hosts. `block`: everything except `blockedHosts`. |
| `hosts` | string | docs sites, GitHub, npm, PyPI, Stack Overflow, ... | Comma-separated allowed hosts. `github.com` also covers `api.github.com`; `*.example.com` covers subdomains only. |
| `blockedHosts` | string | empty | Comma-separated hosts to refuse in block mode, same matching. |
| `checkBash` | boolean | `false` | Also apply the rules to `http(s)://` URLs passed to `curl`, `wget` or httpie in Bash commands (also inside `bash -c "..."`). |

## How it works
- Hooks `tool.call` for `WebFetch` (and `Bash` when `checkBash` is on). The URL is parsed by hand: userinfo, ports, upper case, trailing dots and backslashes are handled, and a URL whose host cannot be read with certainty (escapes, expansions such as `https://$HOST/`, odd characters) is refused in allow mode. A host matches an entry only on a whole-label boundary.
- It is a guard with a `.catch`: if the check itself fails, the call is refused. Session additions live in `$.state`, so a reload keeps them.
- With `checkBash`, commands are read with the shared claude-mods shell reader: wrappers (`sudo`, `env`, `timeout`, `xargs`) are peeled and `bash -c`, `su -c`, `eval`, `$(…)` and heredocs fed to a shell are read too.
- With [mods-hub](../mods-hub) installed, every block is also published as `risk.blocked` (rule `not-allowed`, `blocked-host` or `unreadable-host`, severity `medium`, the URL or command with secrets masked), and the "blocked … /allow-host" note goes through the hub's notifications (`warning`, so it reaches your phone channel while you are away) instead of a toast. Without the hub nothing changes.
- Limits: it sees the URL the tool is called with, not where the site redirects to or what a script does; in Bash only literal `scheme://` URLs on curl, wget and httpie command lines are checked (a URL in a variable, `git clone`, `npm install` or a script is not), so treat `checkBash` as a safety net, not a firewall.
