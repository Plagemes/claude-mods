import type { Sheet } from '../sheet'

export const sql: Sheet = {
  topic: 'sql',
  title: 'SQL',
  aliases: ['psql', 'postgres', 'mysql', 'sqlite'],
  summary: 'queries, joins, writes, schema, windows, client commands',
  markdown: `## Query
    SELECT a, b FROM t WHERE c > 1 ORDER BY a DESC LIMIT 10;  columns, filter, sort, first rows
    SELECT DISTINCT a FROM t;                             unique values
    SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1;  duplicates: HAVING filters groups, WHERE filters rows
    LIMIT 10 OFFSET 20                                    paging
    WHERE a IN (1, 2)  BETWEEN 1 AND 5  LIKE 'ab%'  IS NULL  common predicates (use IS NULL, never = NULL)
    CASE WHEN a > 0 THEN 'pos' ELSE 'neg' END             conditional value
    COALESCE(a, b, 0)                                     first value that is not NULL
    COUNT(*)  SUM(x)  AVG(x)  MIN(x)  MAX(x)              aggregates

## Joins and combining
    FROM a JOIN b ON a.id = b.a_id                       inner join: rows with a match on both sides
    FROM a LEFT JOIN b ON a.id = b.a_id                  every row of a, with b where it matches (NULL otherwise)
    FROM a FULL OUTER JOIN b ON ...                      every row of both (not in MySQL or SQLite < 3.39)
    SELECT ... UNION SELECT ...                          combine results, removing duplicates (UNION ALL keeps them)
    WHERE id IN (SELECT a_id FROM b)                     subquery
    WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id)   has at least one related row
    WITH recent AS (SELECT ...) SELECT ... FROM recent;  common table expression: a named subquery

## Change data
    INSERT INTO t (a, b) VALUES (1, 'x');                 add a row
    UPDATE t SET a = 1 WHERE id = 5;                      change rows: never forget the WHERE
    DELETE FROM t WHERE id = 5;                           delete rows: never forget the WHERE
    INSERT ... ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;  upsert (PostgreSQL, SQLite)
    INSERT ... ON DUPLICATE KEY UPDATE a = VALUES(a);     upsert (MySQL)
    BEGIN;  ...  COMMIT;  or  ROLLBACK;                   make several changes succeed or fail together

## Schema
    CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);  new table
    ALTER TABLE t ADD COLUMN c TEXT;                      add a column
    DROP TABLE t;                                         delete a table and its data
    CREATE INDEX idx_t_a ON t (a);                        speed up lookups on a
    FOREIGN KEY (a_id) REFERENCES a (id)                  link rows to another table
    UNIQUE (a, b)  CHECK (a > 0)  DEFAULT 0               constraints and defaults

## Window functions
    ROW_NUMBER() OVER (PARTITION BY a ORDER BY b)  number rows within each group
    RANK() OVER (ORDER BY score DESC)              rank with ties
    SUM(x) OVER (ORDER BY d)                       running total
    LAG(x) OVER (ORDER BY d)                       the previous row's value (LEAD for the next)

## Inspect
    EXPLAIN ANALYZE SELECT ...;                         run a query and show the plan with real timings (PostgreSQL)
    \\dt   \\d <table>   \\l   \\c <db>   \\q                psql: list tables, describe, list databases, connect, quit
    .tables   .schema <t>   .headers on   .mode column  sqlite3: tables, schema, nicer output
    SHOW TABLES;  DESCRIBE <t>;                         mysql: list tables, describe one
`,
}
