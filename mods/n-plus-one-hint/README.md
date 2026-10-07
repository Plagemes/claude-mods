# n-plus-one-hint
> Spots database queries inside loops, the classic N+1 problem, as Claude writes them.

**Category:** Databases & Data · **Version:** 1.0.0

## What it does
After Claude edits or writes a file, n-plus-one-hint looks for database queries that run once per loop iteration: Prisma `find*`, `Model.find/where`, `.findOne`, repositories, `db.query`, Django `.objects.get/filter`, SQLAlchemy `session.query`, ActiveRecord `where`, Eloquent `Model::where` and plain SQL clients, in JavaScript/TypeScript, Python, Ruby, PHP, Go, Java, Kotlin and C#. Claude gets the file, the line and what to use instead (`include`, `select_related`, `whereIn`, one batched query).

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install n-plus-one-hint@claude-mods
```

## Usage
Nothing to run. You see a toast such as `possible N+1 query in posts.ts:3`, and Claude gets a note:

```
n-plus-one-hint: this edit puts a database query inside a loop, the N+1 pattern (one query per item):
  /repo/src/posts.ts:3  prisma.user.findUnique(...) runs once per iteration
  Instead: fetch the rows together: include/select on the outer query, or one findMany({ where: { id: { in: ids } } }) before the loop.
```

Queries before the loop, in the loop's own header (`for (const u of await prisma.user.findMany())`) and in-memory `.find(...)` on arrays are not flagged. Only what the edit adds is reported, and test files, migrations, seeds and vendored folders are skipped.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`: it reads the file, applies the change in memory, and compares the queries-in-loops before and after, so existing code is not reported again. Nothing is blocked.
- A loop is a `for`/`while`/`foreach` statement or a `forEach`/`map`/`each`-style callback, and its body is the lines indented deeper than the loop line (comments and the inside of strings are ignored), so it works for brace and indentation languages alike.
- Limits: it is a heuristic over text, not a call graph. A query hidden in a helper function called from the loop is not seen, nor is the lazy loading of an ORM relation (`post.comments` inside a loop), and badly indented code may be misread. Edits on a remote machine are not scanned.
- With [mods-hub](../mods-hub) installed: the greeting says it publishes `lint.result` (`tool: n-plus-one-hint`, one warning per query found in a loop), and the toast goes through `notify` at `info` level. Without the hub nothing changes.
