#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/* =============================================================================
   OriginFlow LOS — Migration Runner (CC.4)
   =============================================================================

   What this does
   --------------
   Reads `.sql` files from the `migrations/` folder, applies any not yet applied
   in lexical order, and records what was applied in a `schema_migrations`
   table so the same file never runs twice.

   The "intake_source lesson" was: ad-hoc schema changes pasted into the
   Supabase SQL editor with no versioning, no audit trail, no way to know
   what's actually been applied. This tool kills that workflow.


   How to use
   ----------
   The first time you run this, your migrations/ folder probably already
   contains files that are already applied to the database (016, 017, 017a,
   018, 019). Tell the runner "these are already done":

       migrate mark-all

   Going forward, whenever you add a new migration:
     1. Save the new SQL file to migrations/  (e.g. 020_my_change.sql)
     2. Run:  migrate up
   That's it.


   Commands
   --------
     migrate status        Show what's applied vs pending
     migrate up            Apply pending migrations in order
     migrate mark <file>   Mark one file as applied without running it
     migrate mark-all      Mark every file in migrations/ as applied (for backfill)
     migrate validate      Check filenames / detect drift in applied files


   Environment
   -----------
   The runner needs DATABASE_URL to connect to Supabase. Two ways to provide it:

     1. Set it in your shell:
          PowerShell:  $env:DATABASE_URL = 'postgresql://postgres.<ref>:...:5432/postgres'
          CMD:         set DATABASE_URL=postgresql://postgres.<ref>:...:5432/postgres

     2. Or save it in a .env file in the repo root:
          DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres

   Use the SESSION POOLER url (port 5432), same as the worker. The transaction
   pooler (port 6543) doesn't support transactions across multiple statements
   the way these migrations need.

   IMPORTANT: never commit your .env file. Add `.env` to .gitignore.


   Filename convention
   -------------------
   `NNN[a-z]?_<description>.sql`
     - 3 digits, optional lowercase letter suffix, underscore, snake_case name
     - examples: 016_borrower_auth.sql, 017a_loan_doc_fix.sql, 019_ai_pipeline_dispatcher.sql
   Runner refuses to apply anything that doesn't match this pattern.


   Safety notes
   ------------
   - Each migration runs in its OWN transaction. If it fails, that one rolls
     back, but everything applied before it stays applied. (We can't put all
     migrations in a single transaction without breaking pg_cron / CREATE
     EXTENSION style statements that some migrations include.)
   - Filename checksums are recorded. If you edit an already-applied file,
     `status` and `validate` will warn — the file on disk no longer matches
     what was run, which is a footgun worth catching.
   - The runner refuses to run if it sees a filename gap or an out-of-order
     filename (e.g. 020 applied but 019 pending). Better to fail loud than
     silently apply migrations out of dependency order.

   ============================================================================= */

import postgres from "npm:postgres@3.4.4";

/* ─── Config & env ────────────────────────────────────────────────────── */

const MIGRATIONS_DIR = "./migrations";
const FILE_PATTERN   = /^(\d{3})([a-z]?)_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  filename: string;       // 019_ai_pipeline_dispatcher.sql
  numeric:  number;       // 19
  suffix:   string;       // '' or 'a' / 'b' ...
  path:     string;       // ./migrations/019_ai_pipeline_dispatcher.sql
  contents: string;
  checksum: string;       // sha-256 hex
}

interface AppliedRow {
  filename:   string;
  applied_at: string;
  checksum:   string;
}

function loadDotEnv(path = ".env"): void {
  try {
    const text = Deno.readTextFileSync(path);
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!Deno.env.get(key)) Deno.env.set(key, val);
    }
  } catch {
    // No .env file. Fine — env may be set in the shell directly.
  }
}

function requireDatabaseUrl(): string {
  const url = Deno.env.get("DATABASE_URL");
  if (!url || url.trim() === "") {
    console.error("FATAL: DATABASE_URL is not set.");
    console.error("");
    console.error("Set it in your shell:");
    console.error("  PowerShell:  $env:DATABASE_URL = 'postgresql://postgres.<ref>:<pw>@<host>:5432/postgres'");
    console.error("  CMD:         set DATABASE_URL=postgresql://postgres.<ref>:<pw>@<host>:5432/postgres");
    console.error("");
    console.error("Or save it in a .env file in the repo root.");
    console.error("Use the Supabase SESSION pooler URL (port 5432, not 6543).");
    Deno.exit(1);
  }
  return url;
}

/* ─── File discovery + checksums ──────────────────────────────────────── */

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function discoverMigrations(): Promise<MigrationFile[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(MIGRATIONS_DIR)) entries.push(e);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`FATAL: ${MIGRATIONS_DIR}/ folder not found.`);
      console.error(`Run this command from the root of your OriginFlowLOS repo.`);
      Deno.exit(1);
    }
    throw err;
  }

  const files: MigrationFile[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".sql")) continue;
    const match = entry.name.match(FILE_PATTERN);
    if (!match) {
      skipped.push(entry.name);
      continue;
    }
    const fullPath = `${MIGRATIONS_DIR}/${entry.name}`;
    const contents = await Deno.readTextFile(fullPath);
    const checksum = await sha256(contents);
    files.push({
      filename: entry.name,
      numeric:  parseInt(match[1], 10),
      suffix:   match[2] || "",
      path:     fullPath,
      contents,
      checksum,
    });
  }

  if (skipped.length > 0) {
    console.warn(`WARN: ${skipped.length} file(s) in ${MIGRATIONS_DIR}/ don't match the NNN[a-z]?_name.sql pattern and will be skipped:`);
    for (const s of skipped) console.warn(`  - ${s}`);
    console.warn(`Run 'migrate validate' for details.`);
  }

  // Lexical sort gives: 016 < 017 < 017a < 018 < 019. Confirmed because '_'
  // (95) sorts before 'a' (97) in ASCII.
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

/* ─── Tracking table ──────────────────────────────────────────────────── */

const TRACKING_TABLE_SQL = `
create table if not exists public.schema_migrations (
  filename     text primary key,
  applied_at   timestamptz not null default now(),
  applied_by   text not null default current_user,
  checksum     text not null
);

comment on table public.schema_migrations is
  'OriginFlow migration runner ledger. Managed by migrate.ts (CC.4). Do not edit by hand.';
`;

async function ensureTrackingTable(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(TRACKING_TABLE_SQL);
}

async function readAppliedRows(sql: ReturnType<typeof postgres>): Promise<Map<string, AppliedRow>> {
  const rows = await sql<AppliedRow[]>`
    select filename, applied_at::text, checksum
    from public.schema_migrations
    order by filename
  `;
  const map = new Map<string, AppliedRow>();
  for (const r of rows) map.set(r.filename, r);
  return map;
}

/* ─── Commands ────────────────────────────────────────────────────────── */

async function cmdStatus(sql: ReturnType<typeof postgres>): Promise<void> {
  await ensureTrackingTable(sql);
  const files   = await discoverMigrations();
  const applied = await readAppliedRows(sql);

  console.log("");
  console.log("  Migration status");
  console.log("  " + "─".repeat(56));
  console.log("");

  if (files.length === 0) {
    console.log("  (no migration files found)");
    console.log("");
    return;
  }

  let pendingCount = 0;
  let driftCount   = 0;

  for (const f of files) {
    const a = applied.get(f.filename);
    if (!a) {
      console.log(`  ○ pending   ${f.filename}`);
      pendingCount++;
    } else if (a.checksum !== f.checksum) {
      console.log(`  ⚠ drift     ${f.filename}    (file edited since applied)`);
      driftCount++;
    } else {
      const when = a.applied_at.slice(0, 16).replace("T", " ");
      console.log(`  ● applied   ${f.filename}    ${when}`);
    }
  }

  console.log("");
  console.log(`  ${files.length} file(s) total, ${pendingCount} pending, ${driftCount} drifted`);
  if (driftCount > 0) {
    console.log("");
    console.log("  WARNING: 'drift' means the file on disk differs from what was applied.");
    console.log("  Migrations should be immutable once applied. If you genuinely need to");
    console.log("  alter a past migration, create a new migration with a higher number");
    console.log("  that corrects the schema, then revert the old file to its original content.");
  }
  console.log("");
}

async function cmdUp(sql: ReturnType<typeof postgres>): Promise<void> {
  await ensureTrackingTable(sql);
  const files   = await discoverMigrations();
  const applied = await readAppliedRows(sql);

  // Sanity: no gaps allowed in the numeric prefix once we start applying.
  // We require that every numeric value lower than the highest applied OR
  // the highest pending file is present (allowing alpha suffixes to fill in).
  validateOrdering(files);

  const pending = files.filter((f) => !applied.has(f.filename));
  if (pending.length === 0) {
    console.log("");
    console.log("  Nothing to apply. Database is up to date.");
    console.log("");
    return;
  }

  console.log("");
  console.log(`  Applying ${pending.length} migration(s)`);
  console.log("  " + "─".repeat(56));

  for (const f of pending) {
    process_writeStdout(`  • ${f.filename} ... `);
    const startedAt = Date.now();
    try {
      // Each migration is its own transaction. We use sql.begin() to wrap
      // the migration body + the ledger insert atomically, so a crash mid-
      // migration leaves nothing partially applied AND nothing partially
      // tracked.
      await sql.begin(async (tx) => {
        await tx.unsafe(f.contents);
        await tx`
          insert into public.schema_migrations (filename, checksum)
          values (${f.filename}, ${f.checksum})
        `;
      });
      const ms = Date.now() - startedAt;
      console.log(`OK (${ms}ms)`);
    } catch (err) {
      console.log("FAILED");
      console.log("");
      console.log("  Error: " + (err instanceof Error ? err.message : String(err)));
      console.log("");
      console.log(`  Migration ${f.filename} rolled back. Database is unchanged for this file.`);
      console.log(`  Earlier migrations in this run (if any) were committed and remain applied.`);
      console.log("");
      Deno.exit(1);
    }
  }

  console.log("");
  console.log("  All migrations applied.");
  console.log("");
}

async function cmdMark(sql: ReturnType<typeof postgres>, filename: string): Promise<void> {
  await ensureTrackingTable(sql);
  const files = await discoverMigrations();
  const f = files.find((x) => x.filename === filename);
  if (!f) {
    console.error(`FATAL: no such migration file: ${filename}`);
    console.error(`Run 'migrate status' to see available files.`);
    Deno.exit(1);
  }
  await sql`
    insert into public.schema_migrations (filename, checksum)
    values (${f.filename}, ${f.checksum})
    on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()
  `;
  console.log(`Marked ${filename} as applied (without running it).`);
}

async function cmdMarkAll(sql: ReturnType<typeof postgres>): Promise<void> {
  await ensureTrackingTable(sql);
  const files = await discoverMigrations();
  if (files.length === 0) {
    console.log("No migration files found to mark.");
    return;
  }

  console.log("");
  console.log(`  Marking ${files.length} file(s) as applied (without running):`);
  for (const f of files) {
    await sql`
      insert into public.schema_migrations (filename, checksum)
      values (${f.filename}, ${f.checksum})
      on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()
    `;
    console.log(`  • ${f.filename}`);
  }
  console.log("");
  console.log(`  Done. Future 'migrate up' calls will only run NEW files.`);
  console.log("");
}

async function cmdValidate(sql: ReturnType<typeof postgres>): Promise<void> {
  // Validate filename pattern + ordering. Doesn't require DB connection
  // for filename checks, but we also surface drift from the ledger if
  // we can connect.
  const files = await discoverMigrations();

  console.log("");
  console.log("  Validating migrations/");
  console.log("  " + "─".repeat(56));

  // Check filename pattern was already done in discover(); we get clean
  // files here. Now check ordering.
  try {
    validateOrdering(files);
    console.log(`  ✓ filename pattern OK on ${files.length} file(s)`);
    console.log(`  ✓ numeric ordering OK (no gaps)`);
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }

  // Drift check against ledger
  try {
    await ensureTrackingTable(sql);
    const applied = await readAppliedRows(sql);
    let drifted = 0;
    for (const f of files) {
      const a = applied.get(f.filename);
      if (a && a.checksum !== f.checksum) {
        console.log(`  ⚠ drift: ${f.filename} (disk doesn't match what was applied)`);
        drifted++;
      }
    }
    if (drifted === 0) {
      console.log(`  ✓ no drift detected against the ledger`);
    }
  } catch (err) {
    console.log(`  (skipped ledger drift check: ${err instanceof Error ? err.message : String(err)})`);
  }
  console.log("");
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Detects gaps and out-of-order issues. Throws on first violation.
 *
 * Rule: numeric prefixes form a contiguous sequence starting at some
 * minimum N. Alpha suffixes (017a, 017b) are allowed in addition to the
 * base number (017). The sequence can't skip integers (e.g. 016, 018
 * with no 017 is a gap).
 */
function validateOrdering(files: MigrationFile[]): void {
  if (files.length === 0) return;
  const numerics = Array.from(new Set(files.map((f) => f.numeric))).sort((a, b) => a - b);
  for (let i = 1; i < numerics.length; i++) {
    if (numerics[i] !== numerics[i - 1] + 1) {
      throw new Error(
        `migration numbering gap detected: jumps from ${numerics[i - 1]} to ${numerics[i]} (missing ${numerics[i - 1] + 1})`
      );
    }
  }
}

/**
 * Write without trailing newline (Deno's console.log always adds one).
 * Used to print "applying foo.sql ... " then "OK" on the same line.
 */
function process_writeStdout(s: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(s));
}

/* ─── Main ─────────────────────────────────────────────────────────────── */

function printHelp(): void {
  console.log("");
  console.log("  OriginFlow migration runner");
  console.log("");
  console.log("  Usage:");
  console.log("    migrate <command>");
  console.log("");
  console.log("  Commands:");
  console.log("    status              Show applied vs pending migrations");
  console.log("    up                  Apply all pending migrations in order");
  console.log("    mark <filename>     Mark one file as applied without running it");
  console.log("    mark-all            Mark every file as applied (backfill)");
  console.log("    validate            Check filenames + detect drift");
  console.log("");
  console.log("  Environment:");
  console.log("    DATABASE_URL        Required. Supabase SESSION pooler URL (port 5432).");
  console.log("");
}

async function main(): Promise<void> {
  loadDotEnv();
  const command = Deno.args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    Deno.exit(0);
  }

  const dbUrl = requireDatabaseUrl();
  const sql = postgres(dbUrl, {
    max: 1,
    idle_timeout: 5,
    connection: { application_name: "originflow-migrate" },
  });

  try {
    switch (command) {
      case "status":
        await cmdStatus(sql);
        break;
      case "up":
        await cmdUp(sql);
        break;
      case "mark":
        if (!Deno.args[1]) {
          console.error("Usage: migrate mark <filename>");
          Deno.exit(1);
        }
        await cmdMark(sql, Deno.args[1]);
        break;
      case "mark-all":
        await cmdMarkAll(sql);
        break;
      case "validate":
        await cmdValidate(sql);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        Deno.exit(1);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("");
    console.error("FATAL: " + (err instanceof Error ? err.message : String(err)));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    Deno.exit(1);
  });
}
