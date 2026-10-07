# data-map
> /data-map lists where your code collects, stores and sends personal data — a head start for GDPR.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
`/data-map` scans the codebase for personal data (emails, names, phone numbers, addresses, birth dates, IP addresses, location, cookies and device IDs, payment details, government IDs, credentials), the places it is kept (database models, browser storage, caches, object storage, logs that print it) and the third parties it may reach (analytics, error tracking, email, SMS, payments, CRM, auth, ad pixels, AI APIs). A model then organises the matches into a table you can save as `docs/data-map.md`: the data item, where it is collected (`file:line`), where it is stored, who it is sent to, and a hint at the legal basis.

## Install
```
/plugin install data-map --marketplace plagemes/claude-mods
```

## Usage
`/data-map` opens the pane, scans, then shows the table:

```
🗺 Personal data map · shop-app
9 kinds of personal data · 3 stores · 4 third parties · 41 matches in 9 files
| Data item     | Collected at             | Stored in    | Sent to                  | Legal basis hint        |
| Email address | src/routes/signup.js:10  | MongoDB, logs| SendGrid, Stripe, PostHog| contract; consent (analytics) |
| IP address    | src/routes/signup.js:11  | MongoDB, logs| Sentry (sendDefaultPii)  | legitimate interests    |
## Gaps to check
- PostHog receives the email at signup: check consent …
[ Save to docs/data-map.md ]  [ Copy ]  [ Rescan ]  [ Close ]
```

**Save** writes the table, a short header and the full list of evidence lines to `docs/data-map.md`.

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `model` | `sonnet` | Model alias or id that organises the matches into the table. |
| `output` | `docs/data-map.md` | Where **Save** writes, relative to the project root. |

## How it works
- One `git grep -n -I -i -E` over tracked files (plain `grep -r` outside git), skipping tests, fixtures, docs, Markdown, lockfiles, `.env` and key files, and built or vendored code; each line is then classified by exact patterns in a pure module (at most 40 lines per signal; logging only counts when the line names a data item). Hard-coded secret values (`password: '…'`) are masked in the evidence.
- The grouped evidence goes to `$.model.complete` with instructions to cite only what it was given; if the model does not answer, a table is built from the scan alone (items, the stores and third parties found in the same files, a default legal-basis hint) and marked as such.
- Limits: keyword matching finds names, not data flows, so expect false positives and misses (a field called `contact` is not seen); the legal basis is a hint, not legal advice; the scan and its evidence are sent to the model.
