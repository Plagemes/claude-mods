# fixture-factory
> /fixtures generates realistic test data that matches your schema or types.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
`/fixtures User 20` finds the definition of `User` in your project (a Prisma model, a TypeScript interface, type or
zod schema, a Pydantic/dataclass/Django class, a SQL `CREATE TABLE`, a Go or Rust struct), along with the enums and
models it refers to, and asks Claude for 20 realistic, fake records that respect its types, nullability, enums and
relations. The records are validated as JSON and shown in a pane, ready to save as a fixture file or drop into your prompt.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install fixture-factory@claude-mods
```

## Usage
```
/fixtures User          → 10 records (the default count)
/fixtures order_items 50
/fixtures customers 5   → also finds `CREATE TABLE customers` for `customer`, and the reverse
```
The **Fixtures** pane shows where the definition came from (`prisma/schema.prisma:12`, plus any other matches),
a **▸ Definition** toggle, and a JSON preview of the records. Then:
- **Save** (`s`) writes `tests/fixtures/user.json` (or `test/fixtures`, `__fixtures__`, `spec/fixtures`, else
  `fixtures/`). If the file exists, the button turns into **Replace …** and only a second press overwrites it.
- **Insert into prompt** (`i`) adds the JSON to your prompt, or `@tests/fixtures/user.json` once saved.
- **Regenerate** (`g`) asks again for a fresh set.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `count` | number | `10` | Records generated when `/fixtures` gets no count (200 at most). |
| `outputDir` | string | *(auto)* | Folder Save writes to, relative to the project. |
| `model` | string | `sonnet` | Model that writes the records: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |

## How it works
- The definition is found with `git grep` (tracked and untracked files) or `grep -r` outside a repository,
  skipping `node_modules`, build output and virtualenvs; schema files rank above source files, tests last. Its
  block is cut by braces, parentheses or Python indentation.
- One `$.model.complete` call per batch writes the records; the reply must be a JSON array of objects, and an
  unusable reply is asked for once more. Records missing fields or a short count are flagged in the pane.
- Limits: names must be plain identifiers; related definitions are only looked up in the same file; a reply that
  hits its token budget is refused (ask for fewer records). Values are fake, but check them before committing.
