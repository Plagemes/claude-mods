# graphql-context
> Gives Claude a compact summary of your GraphQL schema when you work on queries and resolvers.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
It finds your schema (the files `codegen.yml` or `.graphqlrc` point to, else every `.graphql`/`.graphqls`/`.gql` file that defines types, or an introspection `schema.json`) and reads it with a small SDL parser: types, inputs, enums, interfaces, unions, scalars, `extend type`, fields with their arguments and defaults. When a prompt is about GraphQL, or Claude reads or edits a resolver, a `.graphql` file or code with `gql` tags, Claude gets a compact version once per conversation: `Query`/`Mutation`/`Subscription` one field per line, then the types they reach, one line each, capped.

## Install
```
/plugin install graphql-context --marketplace plagemes/claude-mods
```

## Usage
- Nothing to run: write "add an author filter to the posts query" and Claude already knows `posts(first: Int = 20, after: String, filter: PostFilter): PostConnection!` and `input PostFilter { … }`.
- `/gql-schema` — the **GraphQL schema** pane: counts, source files, whether Claude has it in this conversation, a filter field (type or field name, shown in full SDL), and **Attach to next prompt** (`a`), **Copy** (`c`), **Reload** (`r`), **Close**.
- `/gql-schema <name>` opens it filtered; `/gql-schema reload` re-reads the files.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `schemaPaths` | string | `""` | Comma-separated schema files or globs (SDL or introspection JSON). Empty: codegen/graphql-config, else every SDL file in the repo. |
| `maxChars` | number | `6000` | Most characters of the compact schema handed to Claude (1000–40000). |

## How it works
- `session.start` loads the schema in the background (`git ls-files`, or a capped folder walk); an `Edit`/`Write` of a schema file reloads it.
- `prompt.submit` adds the compact schema as `context` when the prompt names GraphQL (graphql, gql, resolver, Apollo, `.graphql`, …) or a root field next to "query"/"mutation"/"field"; `tool.call` on `Read`/`Edit`/`Write` adds it to the result of the first GraphQL-related file instead. Once given, it is not repeated until `/clear` or a compaction.
- Limits: code-first schemas (built in TypeScript/Python without SDL files) and remote schema URLs are not read; descriptions and directives are left out of the summary to keep it small.
