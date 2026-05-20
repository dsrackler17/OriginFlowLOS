/**
 * AV scan handler — full implementation.
 *
 * This single file contains everything AV-related:
 *
 *   SECTION 1: ClamAV INSTREAM TCP client
 *   SECTION 2: Magic-byte content sniffing (allowlist-only)
 *   SECTION 3: PDF safety checks
 *   SECTION 4: handleAvScan — the event handler that orchestrates 1–3
 *              and transitions loan_documents through the AV lifecycle
 *
 * Triggered by 'av_scan_requested' events when a borrower upload
 * finalizes. The handler does an eight-step flow:
 *
 *   0. Retry budget check. If we've failed N times for this doc, mark
 *      scan_failed with AV_RETRIES_EXHAUSTED and exit.
 *   1. Atomic state claim. UPDATE status='scanning' WHERE status='uploaded'.
 *      If another agent moved the doc first, bail.
 *   2. Open an ai_extraction_runs row for audit.
 *   3. Fetch metadata + bytes from storage.
 *   4. Hard 25MB size cap.
 *   5. Magic-byte sniffing — must be one of five allowed types AND
 *      must match the declared mime_type.
 *   6. ClamAV INSTREAM scan over TCP.
 *   7. PDF safety checks (if PDF).
 *   8. Finalize — status → scanned_clean (fires classification event)
 *      OR status → scan_failed with rejected_reason set.
 *
 *
 * REJECTED_REASON CODE FORMAT
 * ─────────────────────────────────────────────────────────────────────
 * Machine-parseable CODE:detail. Codes:
 *   AV_RETRIES_EXHAUSTED, FILE_TOO_LARGE, UNKNOWN_TYPE,
 *   DISALLOWED_TYPE, TYPE_MISMATCH, AV_SIGNATURE,
 *   PDF_CONTAINS_JAVASCRIPT, PDF_CONTAINS_EMBEDDED_FILE,
 *   PDF_AUTO_LAUNCH, PDF_MALFORMED_HEADER, etc.
 */

import type { DocEvent } from "./index.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { downloadDocumentBytes } from "./storage.ts";
import {
  countFailedRuns,
  startRun,
  succeedRun,
  failRun,
} from "./runs.ts";
import {
  getDocument,
  claimDocState,
  finalizeDocState,
} from "./doc_state.ts";


// =============================================================================
// SECTION 1 — ClamAV INSTREAM client
// =============================================================================
//
// Talks to clamd on CLAMD_HOST:CLAMD_PORT (defaults to in-container
// 127.0.0.1:3310). Uses INSTREAM which streams file bytes without
// writing them to disk.
//
// PROTOCOL:
//   client → clamd:  zINSTREAM\0
//   client → clamd:  <uint32 BE len><chunk bytes>   (repeat)
//   client → clamd:  <uint32 BE = 0>                 (terminator)
//   clamd  → client: stream: OK\0
//                  | stream: <Signature> FOUND\0
//                  | <error text>\0
// =============================================================================

const CHUNK_SIZE       = 64 * 1024;   // 64KB per write
const SCAN_TIMEOUT_MS  = 30_000;       // 30s overall scan budget

type ScanResult =
  | { status: "OK" }
  | { status: "FOUND"; signature: string }
  | { status: "ERROR"; reason: string };

async function clamavScan(bytes: Uint8Array): Promise<ScanResult> {
  let conn: Deno.TcpConn | null = null;

  const timeoutHandle = setTimeout(() => {
    if (conn) { try { conn.close(); } catch { /* already closed */ } }
  }, SCAN_TIMEOUT_MS);

  try {
    conn = await Deno.connect({
      hostname: config.CLAMD_HOST,
      port:     config.CLAMD_PORT,
      transport: "tcp",
    });

    // 1. Send command (z prefix = null-terminated framing)
    await writeAll(conn, new TextEncoder().encode("zINSTREAM\0"));

    // 2. Stream chunks
    const lenBuf  = new Uint8Array(4);
    const lenView = new DataView(lenBuf.buffer);
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
      const end   = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      lenView.setUint32(0, chunk.byteLength, false); // big-endian
      await writeAll(conn, lenBuf);
      await writeAll(conn, chunk);
    }

    // 3. Terminator (zero-length chunk)
    lenView.setUint32(0, 0, false);
    await writeAll(conn, lenBuf);

    // 4. Read null-terminated response
    const responseText = await readNullTerminated(conn);

    // 5. Parse
    if (responseText === "stream: OK") {
      return { status: "OK" };
    }
    const foundMatch = responseText.match(/^stream:\s+(.+)\s+FOUND$/);
    if (foundMatch) {
      return { status: "FOUND", signature: foundMatch[1] };
    }
    return {
      status: "ERROR",
      reason: `unexpected clamd response: ${responseText.slice(0, 200)}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("clamav scan errored", { reason });
    return { status: "ERROR", reason };
  } finally {
    clearTimeout(timeoutHandle);
    if (conn) { try { conn.close(); } catch { /* ignore */ } }
  }
}

async function writeAll(conn: Deno.TcpConn, data: Uint8Array): Promise<void> {
  let written = 0;
  while (written < data.byteLength) {
    const n = await conn.write(data.subarray(written));
    if (n <= 0) throw new Error("clamd connection closed during write");
    written += n;
  }
}

async function readNullTerminated(conn: Deno.TcpConn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(1024);
  let totalLen = 0;

  while (true) {
    const n = await conn.read(buf);
    if (n === null) {
      throw new Error("clamd connection closed before response terminator");
    }
    if (totalLen + n > 8192) {
      throw new Error("clamd response exceeded 8KB without null terminator");
    }
    const nullIdx = buf.subarray(0, n).indexOf(0);
    if (nullIdx >= 0) {
      chunks.push(buf.slice(0, nullIdx));
      totalLen += nullIdx;
      break;
    }
    chunks.push(buf.slice(0, n));
    totalLen += n;
  }

  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}


// =============================================================================
// SECTION 2 — Magic-byte content sniffing
// =============================================================================
//
// Allowlist-only: we recognize exactly five types — the ones borrowers
// legitimately upload as supporting documents. Anything not matching
// returns null and the handler rejects as UNKNOWN_TYPE.
//
// This is the inverse of how most file-type libraries work (recognize
// hundreds, accept what's in your allowlist). Inverting is safer: a
// borrower-uploaded executable should fail to match anything we
// accept, not be "recognized as PE32+ and then rejected."
// =============================================================================

interface SniffResult { mime: string; ext: string; }

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

function sniffFileType(bytes: Uint8Array): SniffResult | null {
  if (bytes.byteLength < 12) return null;

  // PDF: %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  // HEIC/HEIF: ftyp box at bytes 4-7, brand at 8-11
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "heic" || brand === "heix" || brand === "hevc") {
      return { mime: "image/heic", ext: "heic" };
    }
    if (brand === "mif1" || brand === "heim" || brand === "heis") {
      return { mime: "image/heif", ext: "heif" };
    }
    // Other ftyp brands (mp4, mov, m4a, etc.) deliberately not
    // accepted — they're video/audio, not document supporting material.
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

function mimeMatches(sniffed: string, declared: string): boolean {
  const normalize = (m: string): string => {
    const lower = m.toLowerCase().trim();
    if (lower === "image/jpg")  return "image/jpeg";
    if (lower === "image/heif") return "image/heic";
    return lower;
  };
  return normalize(sniffed) === normalize(declared);
}

function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIMES.has(mime.toLowerCase().trim());
}


// =============================================================================
// SECTION 3 — PDF safety checks
// =============================================================================
//
// ClamAV catches known PDF exploit signatures, but valid PDFs can
// contain JavaScript, embedded files, auto-launch actions, and links
// to phishing pages. None of these belong in mortgage supporting docs.
//
// String-pattern checks on raw PDF bytes for object-syntax markers.
// Not a full PDF parser — content inside FlateDecode streams can hide
// from these checks. ClamAV's PDF.* signature set is the primary
// defense for that; this is belt-and-suspenders for the common cases.
// =============================================================================

interface PdfSafetyResult { safe: boolean; reason: string | null; }

const PDF_SINGLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/JavaScript\b/,    reason: "PDF_CONTAINS_JAVASCRIPT" },
  { pattern: /\/JS\s/,            reason: "PDF_CONTAINS_JS_REFERENCE" },
  { pattern: /\/EmbeddedFile/,    reason: "PDF_CONTAINS_EMBEDDED_FILE" },
  { pattern: /\/EF\s/,            reason: "PDF_CONTAINS_EMBEDDED_FILE_REF" },
  { pattern: /\/SubmitForm/,      reason: "PDF_CONTAINS_SUBMIT_FORM" },
  { pattern: /\/URI\s*\(file:/i,  reason: "PDF_CONTAINS_FILE_URI" },
  { pattern: /\/URI\s*\(ftp:/i,   reason: "PDF_CONTAINS_FTP_URI" },
];

function checkPdfSafety(bytes: Uint8Array): PdfSafetyResult {
  let text: string;
  try {
    // Latin-1: 1 byte → 1 char, lossless for binary content. PDF
    // object syntax is ASCII-safe so the patterns work fine.
    text = new TextDecoder("iso-8859-1").decode(bytes);
  } catch {
    return { safe: false, reason: "PDF_DECODE_FAILED" };
  }

  for (const { pattern, reason } of PDF_SINGLE_PATTERNS) {
    if (pattern.test(text)) return { safe: false, reason };
  }

  // Compound: /Launch + /OpenAction = auto-launch external program on open
  if (/\/Launch\b/.test(text) && /\/OpenAction\b/.test(text)) {
    return { safe: false, reason: "PDF_AUTO_LAUNCH" };
  }

  // Sanity: header version check
  const headerMatch = text.slice(0, 16).match(/^%PDF-(\d+)\.(\d+)/);
  if (!headerMatch) {
    return { safe: false, reason: "PDF_MALFORMED_HEADER" };
  }
  const major = parseInt(headerMatch[1], 10);
  if (major < 1 || major > 2) {
    return { safe: false, reason: "PDF_UNSUPPORTED_VERSION" };
  }

  return { safe: true, reason: null };
}


// =============================================================================
// SECTION 4 — handleAvScan
// =============================================================================

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

export async function handleAvScan(e: DocEvent): Promise<void> {
  // ───── Step 0: Retry budget ──────────────────────────────────────
  const priorFailures = await countFailedRuns(e.document_id, "av_scan");
  if (priorFailures >= config.MAX_RETRIES_AV) {
    log.warn("av_scan: retry budget exhausted", {
      document_id: e.document_id,
      prior_failures: priorFailures,
      max: config.MAX_RETRIES_AV,
    });
    await finalizeDocState({
      id:              e.document_id,
      to:              "scan_failed",
      rejected_at:     true,
      scanned_at:      true,
      rejected_reason: `AV_RETRIES_EXHAUSTED:${priorFailures}_attempts`,
    });
    return;
  }

  // ───── Step 1: Atomic state claim ────────────────────────────────
  const claimed = await claimDocState(e.document_id, "uploaded", "scanning");
  if (!claimed) {
    log.info("av_scan: doc not at 'uploaded' status, skipping", {
      document_id: e.document_id,
      from_status: e.from_status,
      to_status:   e.to_status,
    });
    return;
  }

  // ───── Step 2: Open run record ───────────────────────────────────
  const runId = await startRun({
    loan_document_id: e.document_id,
    loan_id:          e.loan_id,
    branch_id:        e.branch_id,
    call_type:        "av_scan",
    model:            "clamav",
  });

  try {
    // ───── Step 3: Fetch metadata + bytes ──────────────────────────
    const doc = await getDocument(e.document_id);
    log.debug("av_scan: doc loaded", {
      document_id: e.document_id,
      mime_type:   doc.mime_type,
      size:        doc.file_size_bytes,
      storage:     doc.storage_path,
    });

    const bytes = await downloadDocumentBytes(doc.storage_path);

    // ───── Step 4: Hard size cap ───────────────────────────────────
    if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
      await rejectScan(e.document_id, runId, "FILE_TOO_LARGE",
        `${bytes.byteLength}_bytes_exceeds_${MAX_FILE_SIZE_BYTES}`);
      return;
    }

    // ───── Step 5: Content sniffing ────────────────────────────────
    const sniffed = sniffFileType(bytes);
    if (!sniffed) {
      await rejectScan(e.document_id, runId, "UNKNOWN_TYPE",
        "magic_byte_signature_unrecognized");
      return;
    }
    if (!isAllowedMime(sniffed.mime)) {
      await rejectScan(e.document_id, runId, "DISALLOWED_TYPE",
        `sniffed_as_${sniffed.mime}`);
      return;
    }
    if (!mimeMatches(sniffed.mime, doc.mime_type)) {
      await rejectScan(e.document_id, runId, "TYPE_MISMATCH",
        `declared_${doc.mime_type}_sniffed_${sniffed.mime}`);
      return;
    }
    log.debug("av_scan: content sniffed", {
      document_id: e.document_id,
      sniffed:     sniffed.mime,
    });

    // ───── Step 6: ClamAV scan ─────────────────────────────────────
    const scan = await clamavScan(bytes);
    if (scan.status === "ERROR") {
      // Transient. Throw → dispatch logs it → cron picks up stuck doc.
      await failRun({
        run_id:        runId,
        error_message: `clamav_error:${scan.reason}`,
      });
      throw new Error(`clamav scan errored: ${scan.reason}`);
    }
    if (scan.status === "FOUND") {
      await rejectScan(e.document_id, runId, "AV_SIGNATURE", scan.signature);
      return;
    }
    log.debug("av_scan: clamav clean", { document_id: e.document_id });

    // ───── Step 7: PDF safety (if PDF) ─────────────────────────────
    if (sniffed.mime === "application/pdf") {
      const pdfCheck = checkPdfSafety(bytes);
      if (!pdfCheck.safe) {
        await rejectScan(e.document_id, runId, pdfCheck.reason!, "pdf_safety_check");
        return;
      }
      log.debug("av_scan: pdf safety clean", { document_id: e.document_id });
    }

    // ───── Step 8: All clean — finalize ────────────────────────────
    await finalizeDocState({
      id:         e.document_id,
      to:         "scanned_clean",
      scanned_at: true,
    });

    await succeedRun({
      run_id: runId,
      result: {
        sniffed_mime: sniffed.mime,
        sniffed_ext:  sniffed.ext,
        size_bytes:   bytes.byteLength,
        verdict:      "clean",
      },
    });

    log.info("av_scan: clean", {
      document_id: e.document_id,
      mime:        sniffed.mime,
      size_bytes:  bytes.byteLength,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failRun({
      run_id:        runId,
      error_message: msg.slice(0, 2000),
    });
    // Re-throw so dispatch logs the failure. Doc stays at 'scanning';
    // recovery cron will reset to 'uploaded' after 10 minutes.
    throw err;
  }
}

/**
 * Finalize a doc as scan_failed with reason code and audit trail.
 */
async function rejectScan(
  document_id: string,
  run_id:      string,
  reasonCode:  string,
  detail:      string,
): Promise<void> {
  const fullReason = `${reasonCode}:${detail}`;

  await finalizeDocState({
    id:              document_id,
    to:              "scan_failed",
    scanned_at:      true,
    rejected_at:     true,
    rejected_reason: fullReason,
  });

  await succeedRun({
    run_id,
    result: {
      verdict: "rejected",
      reason:  reasonCode,
      detail,
    },
  });

  log.info("av_scan: rejected", {
    document_id,
    reason_code: reasonCode,
    detail,
  });
}
