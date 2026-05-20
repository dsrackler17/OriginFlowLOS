/**
 * Extraction-complete matcher. STUB. Real implementation in patch
 * 12.0.8 (extraction-to-conditions logic).
 *
 * Fires when a document's status transitions from 'extracting' to
 * 'extracted' — extracted_fields has been populated. The matcher's
 * job is to:
 *
 *   1. Pull the loan's current condition set (from `conditions` table,
 *      seeded by AUS findings + branch-specific overlays).
 *
 *   2. Cross-reference extracted values against expected conditions:
 *        - Pay stub income matches stated 1003 income within tolerance?
 *        - Bank balance covers stated reserves?
 *        - Employment matches employment history dates?
 *        - Large deposits explained?
 *
 *   3. For matches: auto-clear the condition with a citation back to
 *      the extracted field + source page/bounding box.
 *
 *   4. For misses: create new conditions describing the discrepancy
 *      and assign the right owner (LO for stated-income mismatch,
 *      borrower for unexplained deposit, etc.).
 *
 *   5. Surface low-confidence classifications and extractions for
 *      manual review (UW workspace).
 *
 * This handler is a stub returning OK — extraction completion is
 * recorded, but the matcher isn't wired yet. Documents will sit at
 * 'extracted' status until either (a) the matcher ships and clears
 * them, or (b) an LO/UW manually accepts/rejects.
 */

import type { DocEvent } from "./index.ts";
import { log } from "../log.ts";

export function handleExtractionComplete(e: DocEvent): Promise<void> {
  log.info("handleExtractionComplete: stub — matcher not wired (ships in 12.0.8)", {
    document_id: e.document_id,
  });
  // Return OK — extraction is genuinely complete, the matcher just
  // isn't connected yet. The doc state stays at 'extracted' for
  // human review.
  return Promise.resolve();
}
