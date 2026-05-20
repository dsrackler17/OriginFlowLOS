/**
 * Structured JSON logger.
 *
 * Every log line is a single JSON object on stdout (or stderr for
 * error/fatal). Fly.io captures these and routes them to whatever log
 * sink is configured. JSON is grep-friendly and parseable by any log
 * aggregator we migrate to later (Loki, Datadog, etc.).
 *
 * Level hierarchy:
 *   debug  — verbose, off in production
 *   info   — normal operational events (handler started, finished)
 *   warn   — recoverable issues (retry triggered, slow handler)
 *   error  — non-recoverable for a single event (retries exhausted)
 *   fatal  — process-level (LISTEN connection won't reconnect)
 *
 * Always pass structured fields, never string interpolation. Bad:
 *   log.info(`processed ${doc.id} in ${ms}ms`);
 * Good:
 *   log.info("processed doc", { document_id: doc.id, duration_ms: ms });
 *
 * The second form is searchable, filterable, and aggregatable. The
 * first is dead text.
 */

import { config } from "./config.ts";

type Level = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
  fatal: 50,
};

const MIN_LEVEL: number =
  config.NODE_ENV === "production" ? LEVEL_ORDER.info : LEVEL_ORDER.debug;

const encoder = new TextEncoder();

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;

  const line = {
    ts:    new Date().toISOString(),
    level,
    msg,
    env:   config.NODE_ENV,
    ...fields,
  };

  // error/fatal to stderr; everything else to stdout. Lets log
  // aggregators route severity-tagged streams differently.
  const stream =
    LEVEL_ORDER[level] >= LEVEL_ORDER.error ? Deno.stderr : Deno.stdout;

  try {
    stream.writeSync(encoder.encode(JSON.stringify(line) + "\n"));
  } catch {
    // Last-ditch — if even logging fails we don't want to throw out
    // of the calling code path.
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit("warn",  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  fatal: (msg: string, fields?: Record<string, unknown>) => emit("fatal", msg, fields),
};
