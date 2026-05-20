/**
 * Handler dispatch.
 *
 * Each event from migration 019's trigger_document_processing maps to
 * exactly one handler function. The mapping lives in the HANDLERS
 * table below; the dispatch function does logging, schema-version
 * validation, and error containment.
 *
 * RESPONSIBILITY CONTRACT (each handler):
 *   - Take ownership by UPDATEing status to the in-progress state
 *     (e.g. 'uploaded' → 'scanning'). This UPDATE is silent at the
 *     trigger level — no notify fires — preventing self-trigger loops.
 *   - Do its work. Stream file bytes, scan, classify, extract, etc.
 *   - Transition status to the next stable state on success
 *     (e.g. 'scanning' → 'scanned_clean'). This UPDATE fires the next
 *     event naturally.
 *   - On failure: log to ai_extraction_runs with error context, then
 *     either retry (leave doc at pre-progress state) or give up after
 *     MAX_RETRIES_* (advance with degraded result, e.g. doc_type =
 *     'unknown').
 *   - Never re-throw to the wider event loop. Handler crashes are
 *     caught here in dispatch() and logged. The doc stays where the
 *     handler left it; the recovery cron handles stuck docs after
 *     the time threshold.
 */

import { log } from "./log.ts";

import { handleAvScan }             from "./av_scan.ts";
import { handleClassification }     from "./classification.ts";
import { handleExtraction }         from "./extraction.ts";
import { handleExtractionComplete } from "./extraction_complete.ts";
import { handleScanFailed }         from "./scan_failed.ts";

/**
 * Payload shape published by `_emit_doc_event` in migration 019.
 * If migration 019 ever bumps the schema, this interface and the
 * version check below must move together.
 */
export interface DocEvent {
  v:           number;
  document_id: string;
  loan_id:     string;
  branch_id:   string;
  event:       string;
  from_status: string;
  to_status:   string;
  ts:          string;
}

export type Handler = (e: DocEvent) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  av_scan_requested:        handleAvScan,
  classification_requested: handleClassification,
  extraction_requested:     handleExtraction,
  extraction_complete:      handleExtractionComplete,
  scan_failed:              handleScanFailed,
};

const SUPPORTED_PAYLOAD_VERSIONS = new Set([1]);

export async function dispatch(e: DocEvent): Promise<void> {
  if (!SUPPORTED_PAYLOAD_VERSIONS.has(e.v)) {
    log.warn("dropping event: unsupported payload version", {
      v: e.v,
      event: e.event,
      document_id: e.document_id,
    });
    return;
  }

  const handler = HANDLERS[e.event];
  if (!handler) {
    log.warn("dropping event: unknown event type", {
      event: e.event,
      document_id: e.document_id,
    });
    return;
  }

  const started = Date.now();
  log.info("handler:start", {
    event:       e.event,
    document_id: e.document_id,
    loan_id:     e.loan_id,
    branch_id:   e.branch_id,
    from_status: e.from_status,
    to_status:   e.to_status,
  });

  try {
    await handler(e);
    log.info("handler:done", {
      event:       e.event,
      document_id: e.document_id,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stack  = err instanceof Error ? err.stack   : undefined;
    log.error("handler:failed", {
      event:       e.event,
      document_id: e.document_id,
      duration_ms: Date.now() - started,
      error:       errMsg,
      stack,
    });
    // Deliberately NOT re-thrown. Handler errors are local; the
    // worker keeps consuming. Recovery cron handles stuck docs.
  }
}
