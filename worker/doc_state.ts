/**
 * loan_documents state transition helpers.
 *
 * Two operations:
 *
 *   1. CLAIM — atomically transition from an expected-from state to
 *      an in-progress state. The UPDATE includes a WHERE clause on
 *      the from-state, so if another worker (or the recovery cron)
 *      has already moved the doc, our UPDATE affects zero rows and
 *      the handler bails.
 *
 *   2. FINALIZE — transition to a terminal-for-this-stage state
 *      (scanned_clean, scan_failed, classified, etc.) with side
 *      effects like setting scanned_at, rejected_reason, or
 *      ai_classified_doc_type. This UPDATE is what fires the next
 *      event via the trigger in migration 019.
 *
 * Both go through supabase-js (PostgREST). Service role bypasses RLS;
 * branch scoping comes from the event payload.
 */

import { supabase } from "./db.ts";
import { log } from "./log.ts";

export interface DocumentRow {
  id:                           string;
  loan_id:                      string;
  branch_id:                    string;
  borrower_id:                  string | null;
  filename:                     string;
  mime_type:                    string;
  file_size_bytes:              number;
  storage_path:                 string;
  status:                       string;
  rejected_reason:              string | null;
  ai_classified_doc_type:       string | null;
  ai_classification_confidence: number | null;
  extracted_fields:             Record<string, unknown> | null;
  extraction_source:            Record<string, unknown> | null;
}

/**
 * Fetch full row for processing. Throws if not found.
 */
export async function getDocument(id: string): Promise<DocumentRow> {
  const { data, error } = await supabase
    .from("loan_documents")
    .select(`
      id, loan_id, branch_id, borrower_id, filename,
      mime_type, file_size_bytes, storage_path,
      status, rejected_reason,
      ai_classified_doc_type, ai_classification_confidence,
      extracted_fields, extraction_source
    `)
    .eq("id", id)
    .single();

  if (error || !data) {
    throw new Error(`getDocument(${id}) failed: ${error?.message ?? "not found"}`);
  }
  return data as unknown as DocumentRow;
}

/**
 * Atomic state claim. UPDATE loan_documents SET status = `to` WHERE
 * id = `id` AND status = `from`. Returns true if the row was claimed,
 * false if another agent already moved it.
 */
export async function claimDocState(
  id:   string,
  from: string,
  to:   string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("loan_documents")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", from)
    .select("id");

  if (error) {
    log.warn("claimDocState update failed", { id, from, to, error: error.message });
    throw new Error(`claimDocState failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Finalize a worker stage by transitioning to a terminal state with
 * associated metadata. The .eq("id", id) ensures we update the right
 * row; this update doesn't gate on from-state because the worker
 * already holds the claim and is the only writer for this stage.
 */
export interface FinalizeParams {
  id:                            string;
  to:                            string;
  scanned_at?:                   boolean;
  classified_at?:                boolean;
  extracted_at?:                 boolean;
  accepted_at?:                  boolean;
  rejected_at?:                  boolean;
  rejected_reason?:              string | null;
  ai_classified_doc_type?:       string;
  ai_classification_confidence?: number;
  extracted_fields?:             Record<string, unknown>;
  extraction_source?:            Record<string, unknown>;
  extraction_error?:             string | null;
}

export async function finalizeDocState(p: FinalizeParams): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status:     p.to,
    updated_at: now,
  };
  if (p.scanned_at)    patch.scanned_at    = now;
  if (p.classified_at) patch.classified_at = now;
  if (p.extracted_at)  patch.extracted_at  = now;
  if (p.accepted_at)   patch.accepted_at   = now;
  if (p.rejected_at)   patch.rejected_at   = now;
  if (p.rejected_reason !== undefined)              patch.rejected_reason              = p.rejected_reason;
  if (p.ai_classified_doc_type !== undefined)       patch.ai_classified_doc_type       = p.ai_classified_doc_type;
  if (p.ai_classification_confidence !== undefined) patch.ai_classification_confidence = p.ai_classification_confidence;
  if (p.extracted_fields !== undefined)             patch.extracted_fields             = p.extracted_fields;
  if (p.extraction_source !== undefined)            patch.extraction_source            = p.extraction_source;
  if (p.extraction_error !== undefined)             patch.extraction_error             = p.extraction_error;

  const { error } = await supabase
    .from("loan_documents")
    .update(patch)
    .eq("id", p.id);

  if (error) {
    log.warn("finalizeDocState update failed", { id: p.id, to: p.to, error: error.message });
    throw new Error(`finalizeDocState failed: ${error.message}`);
  }
}
