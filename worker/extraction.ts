/**
 * Extraction handler. STUB. Implementations land in patches 12.0.2
 * through 12.0.7 (one extractor per doc type).
 *
 * Will:
 *   1. UPDATE loan_documents.status = 'extracting'
 *   2. Read loan_documents.ai_classified_doc_type
 *   3. Route to per-type extractor:
 *        - pay_stub             → 12.0.2 extractor
 *        - bank_statement       → 12.0.3 extractor
 *        - w2                   → 12.0.4 extractor
 *        - tax_return_1040      → 12.0.5 extractor
 *        - id_document          → 12.0.6 extractor
 *        - gift_letter          → 12.0.7 extractor
 *        - letter_of_explanation → 12.0.7 extractor
 *        - form_1099            → generic
 *        - homeowners_insurance → generic
 *        - other                → generic
 *        - unknown              → skip; advance to 'extracted' with
 *                                 empty extracted_fields and a flag
 *   4. Per-type extractor calls Anthropic, writes results to
 *      loan_documents.extracted_fields + extraction_source (citations)
 *   5. UPDATE status = 'extracted' → fires extraction_complete event
 */

import type { DocEvent } from "./index.ts";
import { log } from "./log.ts";

export function handleExtraction(e: DocEvent): Promise<void> {
  log.warn("handleExtraction: NOT IMPLEMENTED (ships in 12.0.2+)", {
    document_id: e.document_id,
  });
  return Promise.reject(new Error("extraction handler not yet implemented"));
}
