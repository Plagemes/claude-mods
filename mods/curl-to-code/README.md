# curl-to-code
> /curl2code turns a curl command into fetch, axios, Python requests or Go code.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
Paste a curl command after `/curl2code` and get ready-to-run code for `fetch`, `axios`, Python `requests` or Go `net/http`, as a fenced block in the transcript. It understands the options that shape a request (`-X`, `-H`, `-d`, `--data-raw`, `--data-binary`, `--data-urlencode`, `--json`, `-u`, `-F`, `-G`, `-T`, `-A`, `-e`, `-b`, `-m`, `-I`, `--url`, `-k`, `--compressed`) and tells you which options it left out. JSON bodies become real objects in the generated code when that loses nothing.

## Install
```
/plugin install curl-to-code --marketplace plagemes/claude-mods
```

## Usage
```
/curl2code curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{"name":"x"}'
/curl2code python curl -u ann:secret https://api.example.com/me
/curl2code go curl -F file=@./report.pdf https://api.example.com/upload
```
A leading `fetch`, `axios`, `python` or `go` picks the language (`js`, `node`, `py`, `requests`, `golang` work too). Without one, the mod setting is used; on `auto` it looks at the project: `go.mod` gives Go, `package.json` gives axios when axios is listed (fetch otherwise), Python project files give Python, anything else gives fetch. Options it ignored (`-o out.txt`, `--retry 3`) and shell variables it could not expand (`$TOKEN`) are listed under the code.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultLanguage` | string | `auto` | `auto`, `fetch`, `axios`, `python` or `go`. Used when the command has no language word. |

## How it works
- Registers `/curl2code` at session start and answers it from `command.run`; nothing is sent over the network and the model is not involved.
- A small shell-style tokenizer (single, double and `$'...'` quotes, backslashes, line continuations, stops at a pipe) feeds a pure parser that builds one request model; one generator per language prints it. Both are plain modules with their own tests.
- Limits: one request per command (extra URLs are listed as ignored); `@file` bodies are read at run time by the generated code; redirects, proxies, retries and cookie jars are left at each library's default; `-k` has no per-request equivalent in `fetch` (a comment says how to do it); Go multipart files are sent as `application/octet-stream`.
