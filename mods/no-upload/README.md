# no-upload
> Blocks commands that upload files to external services like pastebins and file-sharing sites.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
Before a shell command runs, no-upload checks whether it sends data to an outside host: a `curl` or `wget` that posts a file, a pipe into `nc termbin.com`, an `scp` or `rsync` to a remote machine, a `gh gist create`, a bare `/dev/tcp` redirect, a file posted with HTTPie, or `... | ssh host`. If the destination is not allowed, the command is refused and Claude is told to ask you first. Known paste bins and file-sharing sites (pastebin, transfer.sh, 0x0.st, file.io, termbin, ix.io and about 25 more) are refused for any upload, a pasted text included.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install no-upload@claude-mods
```

## Usage
Nothing to run. A blocked command shows Claude:

```
no-upload: blocked `curl -T report.pdf https://file.io`. It would send data to file.io (a file upload (-T)),
which is not on the allowed list. Do not upload files or text to outside services without the user's explicit OK:
tell them what you wanted to send and where, and ask. They can approve it by writing UPLOAD-OK in their next
message, or by adding "file.io" to the allowed hosts in this mod's settings.
```

`UPLOAD-OK` in your next prompt allows uploads for that prompt only (and only when you typed it). Uploads to `localhost`, loopback and private network addresses (10.x, 172.16-31.x, 192.168.x, `*.local`) are never blocked, and downloads are never blocked.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowHosts` | string | empty | Comma-separated hosts uploads may go to. `example.com` allows it and its subdomains, `*.example.com` only its subdomains. |
| `allowWord` | string | `UPLOAD-OK` | When your latest prompt contains this word, uploads are allowed for that prompt. Empty = only `allowHosts`. |

## How it works
- A `tool.call` guard on `Bash` splits the command line the way a shell would (quotes, `&&`, pipes, `$(...)`, `bash -c '...'`, `sudo`/`env`/`timeout`/`xargs` prefixes; comments and here-document bodies are skipped, so a script written with `cat <<EOF` is not mistaken for a command). Each simple command is then read for what it sends where.
- curl: `-T`, `-F name=@file`, `-d @file`, `--data-binary @file`, `--data-urlencode name@file`, `--json @file` and `@-` (stdin) count as file uploads to any outside host; an inline `-d` counts only for paste and sharing sites. wget: `--post-file`, `--body-file`. scp and rsync: a remote destination.
- It fails closed: if the check itself fails on a command that mentions an uploader, the command is blocked.
- Limits: it reads the command, not what a script does. A program that uploads on its own (`python upload.py`, `aws s3 cp`, `rclone`, `git push`, `npm publish`, `docker push`) is not seen, and neither is data inlined with `-d "$(cat file)"` to an ordinary host. It is a guard against careless sharing, not a sandbox.
