/**
 * Scan-failed alerting handler. STUB.
 *
 * Fires when ClamAV or PDF safety rejected a file. In production this
 * should:
 *
 *   1. Notify the borrower via messaging (11.5.8) — "your upload was
 *      rejected for security reasons, please re-upload" without
 *      disclosing the signature name.
 *   2. Alert the branch's compliance contact — could indicate a
 *      compromised borrower endpoint, a phishing payload, or just a
 *      corrupted file.
 *   3. Log to audit_events (13.5.1).
 *
 * For v1 we just log. The borrower will see the doc as 'scan_failed'
 * in their portal status next time they refresh — enough signal to
 * retry. Internal alerting comes with borrower-LO messaging.
 */

import type { DocEvent } from "./index.ts";
import { log } from "./log.ts";

export function handleScanFailed(e: DocEvent): Promise<void> {
  log.warn("scan failed; borrower/internal alerting not yet wired", {
    document_id: e.document_id,
    loan_id:     e.loan_id,
    branch_id:   e.branch_id,
  });
  return Promise.resolve();
}
