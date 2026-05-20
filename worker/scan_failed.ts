/**
 * Scan-failed alerting handler. STUB.
 *
 * Fires when ClamAV (or any of the PDF safety checks) rejected a file.
 * In production this should:
 *
 *   1. Send a notification to the borrower via the messaging system
 *      (11.5.8 backend; UI not yet wired) — "your upload was rejected
 *      for security reasons, please re-upload from a clean source"
 *      without disclosing the signature name.
 *
 *   2. Send an internal alert to the branch's compliance contact —
 *      this could indicate a compromised borrower endpoint, a phishing
 *      payload, or simply a corrupted file. Compliance reviews.
 *
 *   3. Log to an immutable audit_events table (13.5.1).
 *
 * For v1 we just log. The borrower will see the doc as 'scan_failed'
 * in their portal status next time they refresh — which is enough
 * signal to retry. Internal alerting comes in the next round of
 * borrower-LO messaging work.
 */

import type { DocEvent } from "./index.ts";
import { log } from "../log.ts";

export function handleScanFailed(e: DocEvent): Promise<void> {
  log.warn("scan failed; borrower/internal alerting not yet wired", {
    document_id: e.document_id,
    loan_id:     e.loan_id,
    branch_id:   e.branch_id,
  });
  return Promise.resolve();
}
