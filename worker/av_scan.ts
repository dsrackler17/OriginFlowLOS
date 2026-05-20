/**
 * AV scan handler. STUB. Real implementation in patch 12.0.1c.
 *
 * Final responsibilities (when implemented):
 *
 *   1. UPDATE loan_documents.status = 'scanning' (worker takes
 *      ownership; trigger is silent on this transition).
 *
 *   2. Generate a service-role signed URL for the storage object at
 *      loan_documents.storage_path. Download bytes to memory (capped
 *      at the upload size limit, 25 MB).
 *
 *   3. Content sniffing — verify the declared mime_type matches what
 *      the file actually is (libmagic via deno-magic or a fetch-magic-
 *      bytes helper). Reject if the file is an executable, even if
 *      the borrower renamed it to .pdf.
 *
 *   4. ClamAV scan via clamd TCP socket on CLAMD_HOST:CLAMD_PORT.
 *      Send INSTREAM command, stream the bytes, await OK/FOUND. On
 *      FOUND, capture the signature name for the audit trail.
 *
 *   5. PDF-specific safety checks (if doc is a PDF):
 *        - reject embedded JavaScript
 *        - reject embedded files / OpenAction launches
 *        - reject external links to known-bad TLDs
 *      Belt-and-suspenders beyond ClamAV.
 *
 *   6. On clean: UPDATE status = 'scanned_clean', scanned_at = now().
 *      Trigger fires classification_requested.
 *
 *   7. On infected/unsafe: UPDATE status = 'scan_failed',
 *      rejected_reason = '<signature or check name>',
 *      scanned_at = now(). Trigger fires scan_failed event for
 *      alerting.
 *
 *   8. On transient error (network, clamd down): leave doc at
 *      'scanning'. Recovery cron resets to 'uploaded' after 10 min
 *      and re-dispatches.
 */

import type { DocEvent } from "./index.ts";
import { log } from "../log.ts";

export function handleAvScan(e: DocEvent): Promise<void> {
  log.warn("handleAvScan: NOT IMPLEMENTED (ships in 12.0.1c)", {
    document_id: e.document_id,
  });
  throw new Error("av_scan handler not yet implemented");
}
