/**
 * ai_extraction_runs CRUD + retry budget queries.
 *
 * Every worker call (AV scan, classification, extraction) gets a row
 * in ai_extraction_runs for audit and cost tracking. Schema is
 * generic enough to serve all call types:
 *
 *   call_type             — 'av_scan' | 'classify' | 'extract_*'
 *   model                 — model identifier (e.g. 'clamav' or
 *                           'claude-sonnet-4-6')
 *   input_tokens          — 0 for AV; real counts for AI calls
 *   output_tokens         — same
 *   cache_read_tokens     — same
 *   cache_creation_tokens — same
 *   cost_cents            — 0 for AV; computed for AI calls
 *   status                — 'pending' | 'in_progress' | 'success' | 'error'
 *   error_message         — populated on status='error'
 *   result                — full API response jsonb (or summary)
 *   started_at, completed_at, duration_ms
 *
 * Retry budget: each handler checks how many prior 'error' runs
 * exist for (document_id, call_type). If that count >= MAX_RETRIES_*,
 * the handler advances the doc to a degraded final state rather than
 * retrying forever.
 *
 * Orphaned 'in_progress' rows from crashed workers don't count
 * against the retry budget. Periodic cleanup is a TODO.
 */

import { supabase } from "./db.ts";
import { log } from "./log.ts";

export type CallType =
  | "av_scan"
  | "classify"
  | "extract_pay_stub"
  | "extract_bank_statement"
  | "extract_w2"
  | "extract_1040"
  | "extract_id"
  | "extract_gift_letter"
  | "extract_lox"
  | "extract_other";

export type RunStatus = "pending" | "in_progress" | "success" | "error";

export interface StartRunParams {
  loan_document_id: string;
  loan_id:          string;
  branch_id:        string;
  call_type:        CallType;
  model:            string;
}

export interface SucceedRunParams {
  run_id:                 string;
  input_tokens?:          number;
  output_tokens?:         number;
  cache_read_tokens?:     number;
  cache_creation_tokens?: number;
  cost_cents?:            number;
  result?:                Record<string, unknown>;
}

export interface FailRunParams {
  run_id:        string;
  error_message: string;
  result?:       Record<string, unknown>;
}

/**
 * Open a new run record in 'in_progress' state. Returns the row id.
 */
export async function startRun(params: StartRunParams): Promise<string> {
  const { data, error } = await supabase
    .from("ai_extraction_runs")
    .insert({
      loan_document_id:      params.loan_document_id,
      loan_id:               params.loan_id,
      branch_id:             params.branch_id,
      call_type:             params.call_type,
      model:                 params.model,
      status:                "in_progress",
      input_tokens:          0,
      output_tokens:         0,
      cache_read_tokens:     0,
      cache_creation_tokens: 0,
      cost_cents:            0,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`startRun failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

/**
 * Mark a run successful with token + cost details and completion time.
 */
export async function succeedRun(params: SucceedRunParams): Promise<void> {
  const now = new Date();
  const { data: existing } = await supabase
    .from("ai_extraction_runs")
    .select("started_at")
    .eq("id", params.run_id)
    .single();

  const duration_ms = existing
    ? now.getTime() - new Date(existing.started_at as string).getTime()
    : null;

  const { error } = await supabase
    .from("ai_extraction_runs")
    .update({
      status:                "success",
      input_tokens:          params.input_tokens          ?? 0,
      output_tokens:         params.output_tokens         ?? 0,
      cache_read_tokens:     params.cache_read_tokens     ?? 0,
      cache_creation_tokens: params.cache_creation_tokens ?? 0,
      cost_cents:            params.cost_cents            ?? 0,
      result:                params.result                ?? null,
      completed_at:          now.toISOString(),
      duration_ms,
    })
    .eq("id", params.run_id);

  if (error) {
    log.warn("succeedRun update failed", { run_id: params.run_id, error: error.message });
    throw new Error(`succeedRun failed: ${error.message}`);
  }
}

/**
 * Mark a run as failed with an error message.
 */
export async function failRun(params: FailRunParams): Promise<void> {
  const now = new Date();
  const { data: existing } = await supabase
    .from("ai_extraction_runs")
    .select("started_at")
    .eq("id", params.run_id)
    .single();

  const duration_ms = existing
    ? now.getTime() - new Date(existing.started_at as string).getTime()
    : null;

  const { error } = await supabase
    .from("ai_extraction_runs")
    .update({
      status:        "error",
      error_message: params.error_message.slice(0, 2000),
      result:        params.result ?? null,
      completed_at:  now.toISOString(),
      duration_ms,
    })
    .eq("id", params.run_id);

  if (error) {
    log.warn("failRun update failed", { run_id: params.run_id, error: error.message });
    // Don't throw — we're already in a failure path.
  }
}

/**
 * Count prior error-status runs for a document and call type.
 * Used to enforce the retry budget.
 */
export async function countFailedRuns(
  loan_document_id: string,
  call_type: CallType,
): Promise<number> {
  const { count, error } = await supabase
    .from("ai_extraction_runs")
    .select("id", { count: "exact", head: true })
    .eq("loan_document_id", loan_document_id)
    .eq("call_type", call_type)
    .eq("status", "error");

  if (error) {
    log.warn("countFailedRuns query failed", {
      loan_document_id,
      call_type,
      error: error.message,
    });
    // On query error, assume zero — better to give the doc another
    // shot than refuse based on a transient PostgREST issue.
    return 0;
  }
  return count ?? 0;
}
