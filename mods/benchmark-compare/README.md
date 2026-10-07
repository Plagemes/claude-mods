# benchmark-compare
> /bench runs your benchmarks before and after a change and compares the numbers.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
`/bench baseline` runs your benchmark suite and keeps every number, per project and branch. After you (or Claude) change the code, `/bench` runs the suite again and shows a table of each benchmark before and after, with the change coloured: red when slower than your threshold, green when faster, dim when within noise. A regression also shows in the status line until you save a new baseline.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install benchmark-compare@claude-mods
```

## Usage
- `/bench baseline [command]` saves the baseline for the current branch; `/bench [command]` compares; `/bench clear` forgets the branch's baseline.
- With no command it reuses the baseline's, or finds one: a `bench`/`benchmark` script in `package.json` (run with npm, pnpm, yarn or bun), `vitest bench`, `go test -bench=. -benchmem -run=^$ ./...`, `cargo bench`, or `pytest --benchmark-only` when pytest-benchmark is a dependency.
- A branch with no baseline of its own compares with the project's newest one (say, `main`'s), and says so.

```
⏱ Benchmarks · feature/cache vs main @ a1b2c3d (1 h ago)
Benchmark                     Baseline           Now          Change
strs.Concat                    6.89 µs       8.96 µs   ▼ 23.1% slower
strs.Builder                    535 ns        268 ns  ▲ 100.0% faster
sorting > native sort      2616 ops/s    2588 ops/s          ≈ −1.1%
1 slower · 1 faster · 1 same
[ Save as baseline ]  [ Run again ]  [ Close ]
```

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `regressionPercent` | `5` | Slower (or faster) by more than this many percent counts; within it is noise. |
| `command` | *(detect)* | The benchmark command to use when none is given. |
| `timeoutSeconds` | `600` | How long one run may take (at most 600). |

## How it works
- `/bench` runs the command with `$.process.run` in the background (`sh -c` only when it needs a shell) and reads the numbers with pure parsers for vitest bench (hz), benchmark.js (ops/sec), `go test -bench` (ns/op), cargo bench (libtest ns/iter and criterion's middle estimate), pytest-benchmark (the Mean column), hyperfine (mean) and mitata-style `µs/iter` lines.
- Baselines live in the mod's store under the project root and branch, with the command and commit. Throughput (ops/s) and time per op are compared the right way round: the change is how much faster the new run is.
- Limits: one run at a time, ten minutes at most; benchmark names must stay the same to be compared (renamed ones show as new and gone); numbers are as noisy as your machine.
