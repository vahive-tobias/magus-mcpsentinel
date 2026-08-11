import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D1 bills rows *scanned*, not rows returned.
 *
 * A query with no usable index reads the whole table every time it runs. That is
 * survivable against a table with tens of rows and ruinous against one that grows
 * for as long as the monitor keeps running — and it is a documented way to turn a
 * few-dollar account into a four-figure bill, because the platform has no hard
 * spend cap to stop it.
 *
 * These run the real schema through SQLite, which is what D1 is, and fail on any
 * full scan of a table that grows without bound. Growth is the property that
 * matters: watch_targets holds tens of rows by design and scanning it is fine
 * forever, while check_runs gains a row per target per scheduled check.
 */

// Tables that grow for as long as the monitor runs. watch_targets and accounts
// are deliberately absent: they hold tens of rows by design, so scanning them
// costs the same in ten years as it does today.
const UNBOUNDED_TABLES = ["check_runs", "analysis_reports", "change_notices"];

/**
 * Resolve a file relative to the package root.
 *
 * These tests read source files rather than importing them, and they run from
 * `dist/test`, so a path relative to this module would depend on the build
 * layout. Walking up to the directory holding package.json does not.
 */
function packageFile(relative: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("could not locate the package root");
    directory = parent;
  }
  return join(directory, relative);
}

const schemaPath = packageFile("schema.sql");

function plan(sql: string, parameters: unknown[] = []): string[] {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(schemaPath, "utf8"));
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters as never[]) as { detail: string }[];
  database.close();
  return rows.map((row) => row.detail);
}

function fullScansOfGrowingTables(steps: string[]): string[] {
  return steps.filter((step) => {
    if (!/^SCAN /.test(step)) return false;
    if (/USING (COVERING )?INDEX/.test(step)) return false;
    return UNBOUNDED_TABLES.some((table) => step.includes(table));
  });
}

interface StringLiteral {
  value: string;
  start: number;
  end: number;
}

interface ScannedSource {
  literals: StringLiteral[];
  /** The source with comment text blanked out, offsets preserved. */
  withoutComments: string;
}

/**
 * Every string literal in a TypeScript source, in all three quote forms.
 *
 * This replaced a regex that matched only double-quoted strings. `recordDelivery`
 * writes its UPDATE as a template literal, so that statement was never checked —
 * and a `DELETE FROM check_runs` added in backticks passed the suite green.
 * Offsets are kept because the coverage assertion below needs them.
 */
function scan(source: string): ScannedSource {
  const literals: StringLiteral[] = [];
  const withoutComments = source.split("");
  let index = 0;
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) if (withoutComments[at] !== "\n") withoutComments[at] = " ";
  };
  while (index < source.length) {
    const character = source[index]!;
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const start = index;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      literals.push({ value, start, end: index });
      continue;
    }
    index += 1;
  }
  return { literals, withoutComments: withoutComments.join("") };
}

interface RepositoryStatement {
  label: string;
  sql: string;
  parameters: unknown[];
}

/**
 * Every SQL statement the repository issues, read out of its source.
 *
 * This was a hand-kept copy of the statements, and it carried the weakness in a
 * comment: a query added to `repository.ts` and not copied here was unguarded. The
 * copy could also drift the other way — an edited query would leave this file
 * asserting a clean plan for SQL the repository no longer ran. Extracting removes
 * both, and it covers the statements the copy never listed at all, among them
 * `decideNotice`'s UPDATE and every INSERT.
 */
function repositoryStatements(): RepositoryStatement[] {
  const source = readFileSync(packageFile("src/repository.ts"), "utf8");
  return scan(source).literals
    .map((literal) => literal.value.trim())
    .filter((value) => /^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(value))
    .map((sql) => ({
      label: sql.replace(/\s+/g, " ").slice(0, 64),
      sql,
      // The values cannot change the plan, but the statement will not prepare
      // without one per placeholder.
      parameters: Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1)
    }));
}

const STATEMENTS = repositoryStatements();

test("the repository's SQL was found at all", () => {
  // Extraction that silently returns nothing would leave every assertion below
  // vacuously true, which is the failure this whole file exists to avoid.
  assert.ok(STATEMENTS.length > 0, "expected to find SQL statements in repository.ts");
});

for (const { label, sql, parameters } of STATEMENTS) {
  test(`does not scan a growing table: ${label}`, () => {
    const steps = plan(sql, parameters);
    assert.deepEqual(
      fullScansOfGrowingTables(steps), [],
      `Query plan reads a growing table in full, which D1 bills per row:\n  ${steps.join("\n  ")}`
    );
  });
}

// Regression, with a number attached: before check_runs was indexed, finding each
// target's latest check ran a full scan once per target — 1,825,000 rows read per
// call against two years of six-hourly checks on 25 targets, and rising.
test("finding a target's latest check is a seek, not a scan", () => {
  const latestCheck = STATEMENTS.find((statement) => statement.sql.includes("ORDER BY created_at DESC, id DESC LIMIT 1"));
  assert.ok(latestCheck, "the latest-check lookup is no longer in the repository in the shape this pins");

  const steps = plan(latestCheck.sql, latestCheck.parameters);
  const subquery = steps.findIndex((step) => step.includes("CORRELATED SCALAR SUBQUERY"));
  assert.ok(subquery >= 0, "the latest-check lookup should still be a correlated subquery");
  // "COVERING INDEX" is the stronger form — every column the lookup needs lives in
  // the index, so no table row is touched at all. Either satisfies this.
  assert.ok(
    steps.slice(subquery).some((step) => /USING (COVERING )?INDEX idx_check_runs_target_created/.test(step)),
    `the latest-check lookup must use its index:\n  ${steps.join("\n  ")}`
  );
});

// An UPDATE or DELETE without a WHERE clause rewrites every row. That has emptied
// real accounts' budgets in seconds, and it is worth failing the build over.
test("no statement in the repository writes without a WHERE clause", () => {
  const source = readFileSync(packageFile("src/repository.ts"), "utf8");
  const { literals, withoutComments } = scan(source);

  const writes = literals.filter((literal) => /^\s*(UPDATE|DELETE)\b/i.test(literal.value));
  assert.ok(writes.length > 0, "expected to find write statements to check");
  for (const write of writes) {
    assert.match(write.value, /WHERE/i, `unbounded write: ${write.value}`);
  }

  // The assertion above is only worth as much as the scan feeding it, and a guard
  // that checks a subset reports the same green as one that checks everything.
  // So: every write keyword in the file must sit inside a literal that was read.
  // One that does not means SQL arrived by a route this test cannot see.
  for (const match of withoutComments.matchAll(/\b(UPDATE|DELETE)\b/gi)) {
    const offset = match.index ?? -1;
    const covered = literals.some((literal) => offset > literal.start && offset < literal.end);
    assert.ok(
      covered,
      `a ${match[0]} at offset ${offset} is outside every string literal this test read, so it was never checked`
    );
  }
});
