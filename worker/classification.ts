/**
 * Classification handler. STUB. Real implementation in patch 12.0.1d.
 *
 * Will:
 *   1. UPDATE loan_documents.status = 'classifying'
 *   2. Check retry budget against ai_extraction_runs
 *   3. Download bytes; rasterize PDF first page if applicable
 *   4. INSERT ai_extraction_runs row in 'in_progress'
 *   5. Call Anthropic API with structured-output prompt:
 *      {doc_type, confidence, reasoning}
 *   6. Validate doc_type against the CHECK constraint enum (from 019)
 *   7. UPDATE loan_documents: ai_classified_doc_type,
 *      ai_classification_confidence, classified_at, status='classified'
 *   8. UPDATE ai_extraction_runs with tokens + cost_cents on success
 *   9. status transition fires extraction_requested for 12.0.2+
 */

import type { DocEvent } from "./index.ts";
import { log } from "./log.ts";

export function handleClassification(e: DocEvent): Promise<void> {
  log.warn("handleClassification: NOT IMPLEMENTED (ships in 12.0.1d)", {
    document_id: e.document_id,
  });
  return Promise.reject(new Error("classification handler not yet implemented"));
}
