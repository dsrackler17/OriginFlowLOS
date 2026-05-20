/**
 * Environment configuration.
 *
 * The worker reads ALL config from environment. The database holds no
 * credentials, no URLs, no keys — that was the decommission from
 * migration 019. The worker's environment is the single source of
 * truth for everything secret or environment-specific.
 *
 * Required vars fail-fast at boot. Optional vars have documented
 * defaults. Number coercion happens here so the rest of the codebase
 * gets typed values, not strings-that-look-like-numbers.
 *
 * Anything secret is redacted in safeConfig() for log safety. NEVER
 * log `config` directly — always log safeConfig() if you need to dump
 * the boot environment.
 */

interface Config {
  // ─────────────────────────────────────────────────────────────────
  // Database connections
  // ─────────────────────────────────────────────────────────────────

  /**
   * Postgres direct connection — for LISTEN/NOTIFY.
   *
   * MUST be the session-pool URL (port 5432). The transaction pooler
   * on port 6543 does NOT support LISTEN because it doesn't maintain
   * session state across queries. Using the wrong port here will look
   * like "connected but no events ever arrive" — a confusing failure
   * mode worth flagging in CI.
   */
  DATABASE_URL: string;

  /**
   * Supabase project — for the high-level client used for storage,
   * UPDATEs, and ai_extraction_runs INSERTs. Service role key
   * bypasses RLS; branch scoping must be enforced explicitly in our
   * queries (which it is — all queries filter by branch_id when the
   * event carries one).
   */
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // ─────────────────────────────────────────────────────────────────
  // External APIs
  // ─────────────────────────────────────────────────────────────────

  /** Anthropic API key — for classification and extractor calls. */
  ANTHROPIC_API_KEY: string;

  // ─────────────────────────────────────────────────────────────────
  // ClamAV daemon
  // ─────────────────────────────────────────────────────────────────

  /** ClamAV daemon host — default loopback for in-container deploy. */
  CLAMD_HOST: string;
  CLAMD_PORT: number;

  // ─────────────────────────────────────────────────────────────────
  // Worker tuning
  // ─────────────────────────────────────────────────────────────────

  /**
   * Max in-flight handler invocations. Caps concurrency so we don't
   * blow through Anthropic rate limits or saturate ClamAV. 8 is a
   * reasonable starting point for a 1-vCPU shared instance; tune up
   * if the queue depth grows.
   */
  MAX_CONCURRENCY: number;

  /**
   * Retry budgets — after N failures the handler gives up and either
   * marks the doc rejected with reason (AV) or sets doc_type='unknown'
   * with low confidence (classification). Each retry attempt is logged
   * to ai_extraction_runs so the budget can be reasoned about from
   * the DB after the fact.
   */
  MAX_RETRIES_AV: number;
  MAX_RETRIES_CLASSIFY: number;

  // ─────────────────────────────────────────────────────────────────
  // Models
  // ─────────────────────────────────────────────────────────────────

  /**
   * Pinned model strings. Floating model aliases ("claude-3-sonnet")
   * have caused production drift in other systems where a Tuesday
   * silent upgrade changed extraction output. We pin and bump
   * deliberately via env update.
   */
  CLASSIFIER_MODEL: string;

  // ─────────────────────────────────────────────────────────────────
  // Operational
  // ─────────────────────────────────────────────────────────────────

  /** Healthcheck server port. Fly.io probes this. */
  HEALTHCHECK_PORT: number;

  /** Environment label for log tagging. "production" | "staging" | "development". */
  NODE_ENV: string;
}

function req(name: string): string {
  const v = Deno.env.get(name);
  if (!v || v.trim() === "") {
    console.error(`FATAL: required env var ${name} is missing or empty`);
    Deno.exit(1);
  }
  return v;
}

function opt(name: string, dflt: string): string {
  return Deno.env.get(name) ?? dflt;
}

function num(name: string, dflt: number): number {
  const v = Deno.env.get(name);
  if (!v) return dflt;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    console.error(`FATAL: env var ${name}="${v}" is not a number`);
    Deno.exit(1);
  }
  return n;
}

export const config: Config = {
  DATABASE_URL:              req("DATABASE_URL"),
  SUPABASE_URL:              req("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: req("SUPABASE_SERVICE_ROLE_KEY"),
  ANTHROPIC_API_KEY:         req("ANTHROPIC_API_KEY"),
  CLAMD_HOST:                opt("CLAMD_HOST", "127.0.0.1"),
  CLAMD_PORT:                num("CLAMD_PORT", 3310),
  MAX_CONCURRENCY:           num("MAX_CONCURRENCY", 8),
  MAX_RETRIES_AV:            num("MAX_RETRIES_AV", 3),
  MAX_RETRIES_CLASSIFY:      num("MAX_RETRIES_CLASSIFY", 3),
  CLASSIFIER_MODEL:          opt("CLASSIFIER_MODEL", "claude-sonnet-4-6"),
  HEALTHCHECK_PORT:          num("HEALTHCHECK_PORT", 8080),
  NODE_ENV:                  opt("NODE_ENV", "development"),
};

/**
 * Returns a copy of the config with all secrets redacted. Safe to
 * pass to log.info() or any structured logger.
 */
export function safeConfig(): Record<string, unknown> {
  return {
    ...config,
    SUPABASE_SERVICE_ROLE_KEY: "<redacted>",
    ANTHROPIC_API_KEY:         "<redacted>",
    DATABASE_URL:              config.DATABASE_URL.replace(/:[^:@]+@/, ":<redacted>@"),
  };
}
