/**
 * Extraction handler. STUB. Implementations land in patches 12.0.2
 * through 12.0.7 (one extractor per doc type).
 *
 * Final responsibilities (when implemented):
 *
 *   1. UPDATE loan_documents.status = 'extracting' (worker takes
 *      ownership; trigger is silent on this transition).
 *
 *   2. Read loan_documents.ai_classified_doc_type. Route to the
 *      per-type extractor:
 *        - pay_stub             → 12.0.2 extractor
 *        - bank_statement       → 12.0.3 extractor
 *        - w2                   → 12.0.4 extractor
 *        - tax_return_1040      → 12.0.5 extractor
 *        - id_document          → 12.0.6 extractor
 *        - gift_letter          → 12.0.7 extractor
 *        - letter_of_explanation → 12.0.7 extractor
 *        - form_1099            → (not in initial scope; route to 'other')
 *        - homeowners_insurance → (not in initial scope; route to 'other')
 *        - other                → generic key/value extractor
 *        - unknown              → skip; advance to 'extracted' with
 *                                 empty extracted_fields and a flag
 *
 *   3. Each per-type extractor reads file bytes, calls Anthropic API
 *      with type-specific structured-output prompt, writes results to
 *      loan_documents.extracted_fields and extraction_source (the
 *      bounding-box-and-page citation jsonb), logs an ai_extraction_runs
 *      row.
 *
 *   4. UPDATE status = 'extracted'. Fires extraction_complete event
 *      for the matcher (handleExtractionComplete).
 */

import type { DocEvent } from "./index.ts";
import { log } from "../log.ts";

export function handleExtraction(e: DocEvent): Promise<void> {
  log.warn("handleExtraction: NOT IMPLEMENTED (ships in 12.0.2+)", {
    document_id: e.document_id,
  });
  throw new Error("extraction handler not yet implemented");
}
