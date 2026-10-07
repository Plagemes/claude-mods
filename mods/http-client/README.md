# http-client
> /http sends a request and shows the formatted response in a pane, like a tiny Postman in your terminal.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
`/http POST localhost:3000/users {"name":"Ada"}` sends the request through Claude Code's host and opens the **HTTP** pane: status (colored by class), time, size and content type, collapsible request and response headers, and the body pretty-printed (JSON indented and highlighted, Markdown rendered, HTML/XML/YAML highlighted). From there you can copy the request as a curl command, hand the whole exchange to Claude, or send it again. Your last 20 requests are kept across sessions, with secrets masked.

## Install
```
/plugin install http-client --marketplace plagemes/claude-mods
```

## Usage
- `/http [METHOD] <url> [body] [-H "Name: value"]… [-d body]` — the method defaults to `GET` (`POST` when there is a body); a URL without a scheme gets `http://` for localhost and `https://` otherwise, and `:3000/x` means `http://localhost:3000/x`. A JSON body sets `Content-Type: application/json`.
- The transcript gets one line: `GET https://api.example.com/users → 200 OK · 143 ms · 1.2 kB · application/json`.
- Pane buttons: **Headers** (`h`), **Copy as curl** (`c`), **Send to Claude** (`s`, submits the exchange with secret headers masked and the body capped at 20k characters), **Repeat** (`r`), **History** (`y`), **Close**.
- `/http history` lists recent requests with **send** and **edit** (puts the `/http …` line back in your prompt); `/http history clear` forgets them.
- Safety: a request carrying an `Authorization` (or `Proxy-Authorization`) header, or `user:password@` in the URL, is refused over plain `http://` unless the host is this machine (`localhost`, `127.x`, `::1`, `*.localhost`).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutSeconds` | number | `30` | How long to wait for a response (1–300). |

## How it works
- `command.run` parses the line, checks credentials, and calls `$.http.fetch` raced against a `$.clock` timer; the exchange lives in `$.state` for the pane, the history in `$.store`.
- History entries mask `Authorization`, `Cookie`, `*token*`, `*key*`, `*secret*` header values and secret-looking query parameters; an entry that was masked can be edited but not resent as is.
- Limits: requests go through the host's fetch, so redirects are followed for you and the org's web-fetch policy applies; bodies are text (binary responses show their size only); the pane shows the first 60k characters and keeps 200k.
