# heavy-asset-warn
> Warns when large images, videos or fonts are added to the project.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
When Claude writes a file or runs a shell command that puts an image, video or font into your project, heavy-asset-warn checks its size. Over the limit (images 300 KB, videos 2 MB, fonts 200 KB by default) you get a toast and Claude gets a note naming the file and a fix that fits its format: WebP or AVIF for PNG and JPEG, a looping video for an animated GIF, svgo for SVG, ffmpeg settings for video, WOFF2 and subsetting for fonts.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install heavy-asset-warn@claude-mods
```

## Usage
Nothing to run. After `cp ~/Downloads/hero.png public/img/hero.png` you see the toast `public/img/hero.png is 1.8 MB, over the 300 KB image limit` and Claude reads:

```
heavy-asset-warn: a heavy asset was added to the project.
- public/img/hero.png is 1.8 MB (images over 300 KB slow page loads): convert it to WebP or AVIF (cwebp -q 80 in.png -o out.webp), resize it to the largest size it is shown at, and serve responsive sizes with srcset.
Tell the user, and compress or convert before committing unless the size is intended.
```
It looks at `Write`, at `cp`, `mv` and `install` into one of the asset folders, at `curl -o` / `-O` and `wget -O` / `-P`, at `> file` redirects, and at `git add`, which checks every newly staged or modified asset in the repository. A file is reported once per size.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `imageKb` | number | `300` | Images (png, jpg, gif, webp, avif, svg, ...) bigger than this are reported. |
| `videoKb` | number | `2048` | Videos (mp4, mov, webm, ...) bigger than this are reported. |
| `fontKb` | number | `200` | Fonts (ttf, otf, woff, woff2, eot) bigger than this are reported. |
| `directories` | string | `public,assets,static,src,images,img,media,fonts` | Folder names; files that cp, mv, curl or wget put inside one of them, at any depth, are checked. `Write` and `git add` are checked everywhere in the project. |

## How it works
- Hooks `tool.call` for `Write` and `Bash`. The command is split into words the way the shell does (quotes, `&&`, `|`, `cd`, redirects) to find where files land; after the command succeeds the files are measured with `$.fs.stat`. A glob such as `cp *.png public/` is resolved by listing the folder and taking the files written since the command started. `git add` runs `git diff --cached --name-only` in the repository root.
- It never blocks and fails open: a command it cannot read is simply not checked, and nothing runs before the command does.
- Limits: sizes are checked after the fact, so the file is already in place; `rsync`, `unzip`, `tar`, `docker cp`, scripts and build tools that write assets are not seen (`git add` still catches them), and `mv` with a glob is not resolved. Paths built with `$VAR` are skipped.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `risk.blocked` (severity low: the asset is warned about, not blocked) for each heavy asset and sends the warning through `notify` instead of a toast. Without the hub it is the same toast as before. Shell commands are read with the shared shell reader (`shared/shell`), so wrappers such as `sudo`, `env` and `timeout`, `bash -c` and `eval` are understood the same way as in the security guards.
