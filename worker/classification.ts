/**
 * Classification handler. STUB. Real implementation in patch 12.0.1d.
 *
 * Final responsibilities (when implemented):
 *
 *   1. UPDATE loan_documents.status = 'classifying' (worker takes
 *      ownership; trigger is silent on this transition).
 *
 *   2. Check retry budget — count prior ai_extraction_runs rows for
 *      this document_id with call_type = 'classify' and status =
 *      'error'. If >= MAX_RETRIES_CLASSIFY, fall through to step 8.
 *
 *   3. Download file bytes from storage. If the file is a PDF, render
 *      the first 1-2 pages to base64-encoded PNGs for vision input
 *      (Anthropic's vision models accept inline images; PDFs need to
 *      be rasterized first).
 *
 *   4. INSERT ai_extraction_runs row in 'in_progress' state. Hold the
 *      row id to UPDATE on completion.
 *
 *   5. Call Anthropic API with a structured-output prompt. Constrained
 *      JSON: {doc_type, confidence, reasoning}. doc_type must be one
 *      of the 10 allowed values; reasoning is captured for audit and
 *      future prompt tuning.
 *
 *   6. Validate doc_type against the enum locally (defense in depth —
 *      the CHECK constraint on loan_documents.ai_classified_doc_type
 *      catches the bad-write case but we'd rather fail fast at the
 *      API boundary than burn a wasted UPDATE).
 *
 *   7. On success:
 *        - UPDATE loan_documents SET
 *            ai_classified_doc_type       = <result.doc_type>,
 *            ai_classification_confidence = <result.confidence>,
 *            classified_at                = now(),
 *            status                       = 'classified'
 *          (fires extraction_requested event).
 *        - UPDATE ai_extraction_runs SET
 *            status                = 'success',
 *            input_tokens          = ...,
 *            output_tokens         = ...,
 *            cache_read_tokens     = ...,
 *            cache_creation_tokens = ...,
 *            cost_cents            = ...,
 *            model                 = config.CLASSIFIER_MODEL,
 *            result                = <full API response>,
 *            completed_at          = now(),
 *            duration_ms           = ...
 *
 *   8. On retry-exhausted (step 2 caught it):
 *        - UPDATE loan_documents SET
 *            ai_classified_doc_type       = 'unknown',
 *            ai_classification_confidence = 0,
 *            classified_at                = now(),
 *            status                       = 'classified'
 *          (still advances — better to surface to the human than
 *          stay stuck. The matcher in 12.0.8 will flag low-confidence
 *          classifications for manual review).
 *
 *   9. On transient API error: UPDATE ai_extraction_runs SET
 *      status = 'error', error_message = ..., completed_at = now().
 *      Leave loan_documents.status at 'classifying'. Recovery cron
 *      resets to 'scanned_clean' after 10 min and re-dispatches.
 */

import type { DocEvent } from "./index.ts";
import { log } from "../log.ts";

export function handleClassification(e: DocEvent): Promise<void> {
  log.warn("handleClassification: NOT IMPLEMENTED (ships in 12.0.1d)", {
    document_id: e.document_id,
  });
  throw new Error("classification handler not yet implemented");
}
