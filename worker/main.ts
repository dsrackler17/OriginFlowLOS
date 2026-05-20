/**
 * OriginFlow document processing worker — entry point.
 *
 * One process, one purpose: LISTEN on the Postgres `document_processing`
 * channel emitted by migration 019's trigger, and dispatch each event
 * to the appropriate handler.
 *
 *
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────
 *
 *   Postgres                                          this process
 *   ────────                                          ────────────
 *   loan_documents
 *     UPDATE status                                   sql.listen("document_processing", ...)
 *        ↓                                                ↑
 *   trigger_document_processing                           │ TCP, long-lived
 *        ↓                                                │
 *   pg_notify('document_processing', payload) ────────────┘
 *                                                         │
 *                                                         ▼
 *                                                   payload → JSON.parse → DocEvent
 *                                                         │
 *                                                         ▼
 *                                                   withSlot (concurrency semaphore)
 *                                                         │
 *                                                         ▼
 *                                                   dispatch(event) → handler function
 *
 *
 * FAILURE MODES (and how each is handled)
 * ─────────────────────────────────────────────────────────────────────
 *
 *   - Connection drops mid-LISTEN: porsager/postgres reconnects
 *     transparently. Events fired during the gap are LOST (NOTIFY is
 *     at-most-once). Recovered by migration 019's recovery cron.
 *
 *   - Handler throws: caught inside dispatch(), logged with stack,
 *     doc stays where the handler left it. Recovery cron picks up
 *     stuck docs after 5/10 min thresholds.
 *
 *   - Handler hangs forever: in-flight slot never releases, eventually
 *     MAX_CONCURRENCY slots are all stuck, no new events processed.
 *     Health probe stays green (LISTEN is alive). Visible as a backlog
 *     in monitoring. We accept this for v1; per-handler timeouts come
 *     when we have data on real-world latency distributions.
 *
 *   - Process crashes: Fly.io restarts the VM (10-30s). Stuck docs
 *     recovered by cron.
 *
 *   - SIGTERM: graceful — stop accepting new events, drain in-flight,
 *     close connection, exit. fly.toml requests 30s kill_timeout.
 *
 *
 * MULTI-INSTANCE NOTE
 * ─────────────────────────────────────────────────────────────────────
 *
 *   This worker is designed to run as a SINGLE instance. Running
 *   multiple would mean each instance gets a copy of every NOTIFY
 *   payload, and they'd race to UPDATE the same loan_documents row —
 *   sometimes harmlessly (status transitions are idempotent), but
 *   sometimes double-billing the Anthropic API.
 *
 *   When we need horizontal scale, the right move is: keep NOTIFY for
 *   wake-up signals, but have each handler claim its work with a
 *   FOR UPDATE SKIP LOCKED query that atomically transitions the doc
 *   to the in-progress state. Whichever instance wins the lock owns
 *   the work. Until then: single instance, scale vertically.
 */

import { sql } from "./db.ts";
import { config, safeConfig } from "./config.ts";
import { log } from "./log.ts";
import { dispatch, DocEvent } from "./index.ts";

// ─────────────────────────────────────────────────────────────────────
// Concurrency control
// ─────────────────────────────────────────────────────────────────────
// A counting semaphore. Handlers acquire on entry, release on exit. If
// at limit, new events queue in `pending`. The LISTEN connection keeps
// draining regardless — events aren't dropped, just delayed.

let inFlight = 0;
let shuttingDown = false;
const pending: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= config.MAX_CONCURRENCY) {
    await new Promise<void>((res) => pending.push(res));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = pending.shift();
    if (next) next();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Healthcheck server
// ─────────────────────────────────────────────────────────────────────
// Fly.io probes GET /health on HEALTHCHECK_PORT. 200 if the LISTEN
// connection is alive AND we're not shutting down; 503 otherwise (Fly
// will replace the VM after repeated failures).

let listenAlive = false;

function startHealthServer(): void {
  Deno.serve({ port: config.HEALTHCHECK_PORT, hostname: "0.0.0.0" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      const healthy = listenAlive && !shuttingDown;
      const body = JSON.stringify({
        status:          healthy ? "ok" : "degraded",
        listen_alive:    listenAlive,
        shutting_down:   shuttingDown,
        in_flight:       inFlight,
        pending:         pending.length,
        max_concurrency: config.MAX_CONCURRENCY,
      });
      return new Response(body, {
        status:  healthy ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  log.info("health server up", { port: config.HEALTHCHECK_PORT });
}

// ─────────────────────────────────────────────────────────────────────
// LISTEN loop
// ─────────────────────────────────────────────────────────────────────

async function runListen(): Promise<void> {
  log.info("worker starting", { config: safeConfig() });

  await sql.listen(
    "document_processing",
    (payload: string) => {
      if (shuttingDown) return;

      let event: DocEvent;
      try {
        event = JSON.parse(payload);
      } catch (e) {
        log.error("malformed notify payload", {
          payload: payload.slice(0, 200),
          error:   e instanceof Error ? e.message : String(e),
        });
        return;
      }

      void withSlot(() => dispatch(event)).catch((err) => {
        log.error("dispatch crashed unexpectedly", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    () => {
      listenAlive = true;
      log.info("listening on document_processing");
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  listenAlive = false;
  log.info("shutdown initiated", { signal, in_flight: inFlight });

  const deadline = Date.now() + 25_000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (inFlight > 0) {
    log.warn("shutdown deadline reached; abandoning in-flight handlers", {
      in_flight: inFlight,
    });
  }

  try {
    await sql.end({ timeout: 5 });
  } catch (e) {
    log.error("error closing sql connection during shutdown", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log.info("shutdown complete");
  Deno.exit(0);
}

Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT",  () => void shutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  startHealthServer();
  runListen().catch((err) => {
    log.fatal("listen loop crashed unrecoverably", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack   : undefined,
    });
    Deno.exit(1);
  });
}
