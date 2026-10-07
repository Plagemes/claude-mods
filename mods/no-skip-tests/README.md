# no-skip-tests
> Blocks Claude from silencing tests with .skip, .only, xit or skip markers.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
A failing test is information; a skipped test is a lie. When Claude edits or writes a test file and the change adds a skip or focus marker that was not there before, the edit is refused with a message telling it to fix the test or the code instead. Markers that were already in the file are left alone, and so are ordinary edits.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install no-skip-tests@claude-mods
```

## Usage
Nothing to do. A blocked edit shows Claude: `no-skip-tests: this change adds .skip / .only to /repo/a.test.ts. Fix the test or the code instead of silencing the test. If the user really wants it, ask them to put SKIP-OK in their next message.` If you do want a skip, put `SKIP-OK` in your next prompt; it applies until your following prompt.

Recognised markers: `it/test/describe/context.skip` and `.only` (any chain, such as `test.describe.only`), `fit`, `fdescribe`, `xit`, `xdescribe`, `xtest`, `xcontext` (JavaScript, TypeScript, Ruby), `@pytest.mark.skip` and `@unittest.skip`, Go `t.Skip(` / `t.Skipf(` / `t.SkipNow(`, Rust `#[ignore]`, and JUnit `@Disabled` / `@Ignore`. Conditional skips (`skipif`, `skipIf`) are allowed.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `allowWord` | `SKIP-OK` | Word that, in your latest prompt, allows skip markers. Empty means never allow. |

## How it works
- Hooks `tool.call` for `Edit`, `Write` and `MultiEdit`. For `Edit` it compares `old_string` with `new_string`; for `Write` it compares the file on disk (read with `$.fs.read`) with the new content. A marker only counts when there are more of its kind afterwards than before.
- A file counts as a test file by name (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*Test.java`, a `tests/`, `__tests__/` or `spec/` folder); every `.rs` file is checked because Rust keeps tests inline.
- It guards quality, not security, so it fails open: if the file cannot be read the change goes through. Only the file tools are watched, not a `sed -i` in Bash.
