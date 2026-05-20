/**
 * Database clients.
 *
 * Two clients, two purposes.
 *
 * `sql` — porsager/postgres connection used ONLY for LISTEN/NOTIFY.
 *   Maintains a long-lived connection. The library handles reconnect
 *   automatically: if the socket drops, it re-establishes and
 *   re-issues the LISTEN. Events fired during the gap are LOST and
 *   recovered by the cron in migration 019, not by the worker.
 *
 *   Connection requires the SESSION-pool URL (port 5432). The
 *   TRANSACTION pooler (port 6543) does not support LISTEN — using
 *   it produces "connected but no events ever arrive," a fault mode
 *   easy to miss without explicit testing.
 *
 * `supabase` — high-level @supabase/supabase-js client used for
 *   everything else: SELECT loan_documents, UPDATE status, INSERT
 *   ai_extraction_runs, storage.createSignedUrl for downloading
 *   uploaded files. Uses the service role JWT which bypasses RLS,
 *   so branch scoping must be enforced explicitly in every query
 *   the worker issues. Branch ID is always on the event payload.
 */

import postgres from "postgres";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { log } from "./log.ts";

export const sql = postgres(config.DATABASE_URL, {
  // Single connection. We're LISTENing, not running concurrent
  // queries. If we ever need a second query path, open a separate
  // client rather than expanding the pool here — keeping the LISTEN
  // connection isolated avoids head-of-line blocking from slow
  // queries.
  max: 1,

  // No idle timeout — we want this connection to stay open
  // indefinitely. The library still reconnects automatically if the
  // server closes the connection from its end.
  idle_timeout: 0,
  max_lifetime: null,

  connection: {
    application_name: "originflow-worker",
  },

  // Postgres NOTICE / WARNING / etc. routed to our structured logger.
  onnotice: (n: unknown) => log.debug("pg notice", { notice: String(n) }),
});

export const supabase: SupabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        // Tag every Supabase request so we can identify worker
        // traffic in the project logs.
        "x-application-name": "originflow-worker",
      },
    },
  },
);
