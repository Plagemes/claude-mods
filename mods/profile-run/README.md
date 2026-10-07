# profile-run
> /profile runs a command under a profiler and shows the hottest functions.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
`/profile <command>` runs the command under the right CPU profiler, then shows a table of the hottest functions: where each one is (`file:line`), the milliseconds spent in it alone, its share of the run, and its total share with what it calls. One button hands the top three to Claude to optimise.

## Install
```
/plugin install profile-run --marketplace plagemes/claude-mods
```

## Usage
- `/profile node scripts/build.js`, `/profile npm run build`, `/profile npx vitest run`: Node's `--cpu-prof` (through `NODE_OPTIONS` for npm, npx and other JS tools; of several node processes, the busiest is shown).
- `/profile python3 app.py`, `/profile python -m mypkg`, `/profile pytest tests/test_api.py`: cProfile, read back with pstats (the project's `.venv` python for pytest).
- `/profile go test -run TestHot ./internal/hot`: `-cpuprofile` and `go tool pprof -top` (one package at a time; for `go run` the pane explains how to use pprof).
- `/profile` alone reopens the last result.

```
🔥 Profile · node slow.js
181 ms sampled · node · 1 process · .claude/profiles/CPU.20261007.161303.13149.0.001.cpuprofile
 # Function            Location        Self ms   Self   Total
 1 sortNumbers         slow.js:3         111.9  61.7%   69.9%  ██████████
 2 buildStrings        slow.js:2          15.3   8.4%    8.4%  █
 3 (anonymous)         slow.js:3          14.8   8.1%    8.1%  █
[ Ask Claude to optimise top 3 ]  [ Sort by total ]  [ Run again ]  [ Close ]
```

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `rows` | `15` | How many functions the table lists. |
| `timeoutSeconds` | `300` | How long the profiled command may run (at most 600). |

## How it works
- The command runs from the project root with `$.process.run` in the background; profiles go to `.claude/profiles/` (add it to `.gitignore`; old ones are not deleted).
- `.cpuprofile` files are aggregated by a pure function: self time per function from the sample time deltas, total time counted once per call path so recursion is not counted twice, idle time left out. Files over 4 MB are first compacted by a small `node -e` script. cProfile stats are printed as JSON by a `python -c` pstats script; pprof's `-top -filefunctions` table is parsed as text.
- Limits: one command at a time, without pipes or `&&`; Go rows name the file but not the line; `python -c` cannot be profiled; Bun, Deno and other runtimes are not supported.
