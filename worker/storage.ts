/**
 * Supabase Storage download helper.
 *
 * The worker uses the service-role key, which bypasses storage RLS
 * entirely. We can download any file in the loan-documents bucket
 * regardless of branch — which is what we want, because the worker
 * processes events from all branches but isn't authenticated as any
 * specific user.
 *
 * Branch scoping is enforced at the handler level: every event
 * payload carries a branch_id, and the handler uses it when querying
 * loan_documents. Storage access is wide-open by design.
 */

import { supabase } from "./db.ts";
import { log } from "./log.ts";

const BUCKET = "loan-documents";

/**
 * Download a file from the loan-documents bucket. Path is the
 * storage_path stored on the loan_documents row.
 *
 * Throws on download failure. Caller is responsible for catching and
 * translating to an appropriate run-failure state.
 */
export async function downloadDocumentBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .download(storagePath);

  if (error) {
    log.warn("storage download failed", {
      bucket: BUCKET,
      path:   storagePath,
      error:  error.message,
    });
    throw new Error(`storage download failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("storage download returned no data");
  }

  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Generate a short-lived signed URL for a storage object. Used by the
 * classification handler (12.0.1d) when handing image URLs to
 * Anthropic's vision API. Not used by AV — AV downloads bytes
 * directly.
 */
export async function signedUrlFor(
  storagePath: string,
  ttlSeconds: number = 300,
): Promise<string> {
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);

  if (error || !data) {
    throw new Error(`signed URL generation failed: ${error?.message ?? "no data"}`);
  }
  return data.signedUrl;
}
