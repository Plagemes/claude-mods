# csv-peek
> /peek shows a CSV or JSONL file's columns, sample rows and inferred types without reading the whole file.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
`/peek <path> [rows]` reads only the first 64 KB of a CSV, TSV or JSON Lines file, works out the delimiter, the header, each column's type (int, float, bool, date, datetime, string, object, array) and how often it is empty, and prints a Markdown summary with the first rows. A 4 GB export costs one `head` and one `wc -l`. It also stops Claude from reading a big data file whole with the Read tool.

## Install
```
/plugin install csv-peek --marketplace plagemes/claude-mods
```

## Usage
```
/peek data/orders.csv
/peek "my exports/events.jsonl" 10
/peek ~/Downloads/people.tsv
```
The output is a headline (`**data/orders.csv** · 412.0 MB · ~5,120,330 rows · 14 columns · CSV, delimiter ; · header row`), a table of columns with type, empty share and an example value, and the first 5 rows (up to 50 with the second argument). Empty means blank or a null token (`NULL`, `NaN`, `N/A`, `\N`, `None`).

When Claude calls Read on a `.csv`, `.tsv`, `.jsonl` or `.ndjson` file over 1 MB without a `limit`, the call is refused with `csv-peek: data/orders.csv is 412.0 MB, too big to read whole. Read a slice with offset and limit, or sample it with Bash (head -n 20, wc -l). The user can run /peek data/orders.csv ...`. Slash commands are typed by you, so Claude is pointed at `offset`/`limit` and `head`, and told that `/peek` exists.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `sampleKb` | number | `64` | How much of the start of the file /peek reads to infer columns and types. |
| `maxReadKb` | number | `1024` | Data files bigger than this are refused when read without a `limit`. `0` turns the guard off. |

## How it works
- `/peek` takes the first `sampleKb` of the file with `head -c` (the file API has no byte range) and counts lines with `wc -l`; a file that fits in the sample is read whole and the counts are exact. If `head` is missing and the file is under 1 MB it is read with `$.fs.read`.
- CSV parsing handles quotes, doubled quotes, newlines inside quotes and CRLF; the delimiter (`,` `;` tab `|`) is sniffed from the first lines, and a first row that is all numbers or dates is treated as data. A record cut by the sample is dropped. JSON Lines may also be detected by content.
- `tool.call` on `Read` checks `$.fs.stat` for the guard and fails open: if the check breaks the read goes ahead. Types come from the sample only, so a column that turns into text on row 900,000 is reported by what the first rows look like. Row counts for big files are `wc -l` minus the header, so a quoted newline makes them slightly high. Needs `head` and `wc` (macOS and Linux).
