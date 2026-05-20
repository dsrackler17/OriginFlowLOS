/**
 * Extraction-complete matcher. STUB. Real implementation in patch
 * 12.0.8 (extraction-to-conditions logic).
 *
 * Fires when a document's status transitions from 'extracting' to
 * 'extracted' — extracted_fields has been populated. The matcher:
 *
 *   1. Pulls the loan's current condition set (conditions +
 *      condition_templates tables).
 *   2. Cross-references extracted values against expected conditions:
 *        - pay stub income matches stated 1003 income within tolerance?
 *        - bank balance covers stated reserves?
 *        - employment matches employment history dates?
 *        - large deposits explained?
 *   3. Auto-clears conditions on match with source citation.
 *   4. Creates new conditions on discrepancy, assigning owner.
 *   5. Flags low-confidence classifications/extractions for UW review.
 *
 * Stub returns OK — extraction completion is recorded, but the
 * matcher isn't wired yet. Documents will sit at 'extracted' status
 * until either (a) the matcher ships or (b) LO/UW manually accepts.
 */

import type { DocEvent } from "./index.ts";
import { log } from "./log.ts";

export function handleExtractionComplete(e: DocEvent): Promise<void> {
  log.info("handleExtractionComplete: stub — matcher not wired (ships in 12.0.8)", {
    document_id: e.document_id,
  });
  return Promise.resolve();
}
