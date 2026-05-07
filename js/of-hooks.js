// ═══════════════════════════════════════════════════════════════════════════
// /js/of-hooks.js — Round 2 implementations of the OF_* hooks
//
// Load BEFORE documents.html's inline <script> with:
//   <script src="/js/of-hooks.js"></script>
//
// Implements:
//   • window.OF_uploadFile          — uploads to Supabase Storage 'loan-documents'
//                                     bucket, kicks scan-document, returns
//                                     initial_status='quarantined' so the
//                                     documents.html page knows to wait.
//   • window.OF_extractDocument     — invokes the extract-document edge
//                                     function which calls Claude Opus 4.7.
//   • window.OF_applyExtractionAction — invokes apply-extraction-action
//                                       (you wire this to your write-back
//                                       logic — stubbed below).
//
// The page degrades gracefully if any of these throw — see documents.html
// runExtraction() for the failure path.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function supa() {
    if (typeof getSupabase !== 'function') {
      throw new Error('getSupabase() not on window. Make sure /js/config.js is loaded.');
    }
    const client = getSupabase();
    if (!client) throw new Error('Supabase client unavailable');
    return client;
  }

  // Generates a path under the bucket: <branch_id>/<loan_id_or_'branch'>/<uuid>.<ext>
  // The leading branch_id segment is what the storage RLS policies key off of.
  async function buildStoragePath(file, loanIdOrNull) {
    const { data: { session } } = await supa().auth.getSession();
    if (!session) throw new Error('Not signed in');

    const { data: profile, error } = await supa()
      .from('profiles').select('branch_id')
      .eq('id', session.user.id).maybeSingle();
    if (error || !profile?.branch_id) throw new Error('Could not resolve branch');

    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 6);
    const uuid = crypto.randomUUID();
    const folder = loanIdOrNull || 'branch';
    return `${profile.branch_id}/${folder}/${uuid}.${ext}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. UPLOAD — Supabase Storage + async malware scan
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // documents.html calls this with (file, onProgress). Returns:
  //   { file_url, file_size_bytes, mime_type, initial_status: 'quarantined' }
  //
  // The 'quarantined' initial status tells documents.html to insert the
  // documents row with that status. The scan-document edge function then
  // flips it to 'uploaded' or 'infected', and the realtime listener picks
  // up the change.
  // ═══════════════════════════════════════════════════════════════════════════

  window.OF_uploadFile = async function (file, onProgress) {
    // Cheap defense: reject obviously bad MIMEs before paying for an upload
    const ALLOWED = [
      'application/pdf',
      'image/png', 'image/jpeg', 'image/jpg',
    ];
    if (!ALLOWED.includes(file.type)) {
      throw new Error(`File type "${file.type || 'unknown'}" not allowed. Use PDF, PNG, or JPEG.`);
    }

    const path = await buildStoragePath(file, getLoanIdFromContext());

    if (typeof onProgress === 'function') onProgress(10);

    // Supabase Storage doesn't surface true upload progress on the JS
    // client, so we report a coarse 10 → 100. If you need real progress,
    // swap to the resumable upload protocol or a presigned PUT.
    const { error: upErr } = await supa()
      .storage.from('loan-documents')
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });
    if (upErr) {
      // Common case: bucket doesn't exist yet, or RLS denies. Surface
      // both clearly.
      if (upErr.message?.includes('Bucket not found')) {
        throw new Error('Storage bucket "loan-documents" not created yet. Run sql/02_storage_bucket.sql.');
      }
      throw new Error(`Upload failed: ${upErr.message}`);
    }

    if (typeof onProgress === 'function') onProgress(85);

    // Storing the path (not a signed URL) — we generate signed URLs on read.
    // That keeps the persisted record stable when signed URLs expire.
    const file_url = path;

    // Kick off async malware scan. We don't await — the scan runs while
    // the user keeps interacting. The page realtime-listens for the
    // status flip from 'quarantined' to 'uploaded'.
    //
    // We can't fire this until the documents row exists, but documents.html
    // inserts the row AFTER OF_uploadFile resolves. So we return a marker
    // (initial_status) and let the page re-trigger the scan after insert.
    // To avoid that round-trip latency, we instead enqueue the scan via a
    // setTimeout-after-resolve trick: the documents.html insert completes
    // synchronously after this function returns, so a 1s defer is reliable.

    const branchAndLoan = { path };
    setTimeout(async () => {
      try {
        // Wait until the documents row exists. We poll for up to 10s.
        const docId = await waitForDocByFileUrl(path, 10_000);
        if (!docId) return;
        const { error: scanErr } = await supa().functions.invoke('scan-document', {
          body: { document_id: docId },
        });
        if (scanErr) console.warn('scan-document invoke failed:', scanErr);
      } catch (err) {
        console.warn('scan kick-off failed:', err);
      }
    }, 1000);

    if (typeof onProgress === 'function') onProgress(100);

    return {
      file_url,
      file_size_bytes: file.size,
      mime_type: file.type,
      initial_status: 'quarantined',
    };
  };

  // documents.html stores loan_id in the upload modal select; pull it from there.
  function getLoanIdFromContext() {
    const sel = document.querySelector('#upload-loan');
    return sel && sel.value ? sel.value : null;
  }

  // After the upload returns, documents.html inserts a row. We poll for it
  // by file_url so we can fire the scan with the correct document_id.
  async function waitForDocByFileUrl(fileUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data } = await supa().from('documents')
        .select('id').eq('file_url', fileUrl)
        .order('uploaded_at', { ascending: false })
        .limit(1).maybeSingle();
      if (data?.id) return data.id;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. EXTRACT — invoke the edge function that calls Claude Opus 4.7
  // ═══════════════════════════════════════════════════════════════════════════
  window.OF_extractDocument = async function (documentId) {
    const { data, error } = await supa().functions.invoke('extract-document', {
      body: { document_id: documentId },
    });
    if (error) {
      // supabase-js wraps non-2xx as an error with .context for the body
      let msg = error.message || 'Extraction failed';
      try {
        if (error.context) {
          const body = await error.context.json();
          if (body?.error) msg = body.error;
        }
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return data;  // exact shape OF_extractDocument expects
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. APPLY EXTRACTION ACTION — write-back to loan/borrower/condition
  //
  // For round 2, this is delegated to a separate edge function (or RPC) you
  // implement next. Until it's wired, this stub records a no-op "applied"
  // and lets the page mark the action as applied so the UI flows. Replace
  // with a real call once apply-extraction-action ships.
  // ═══════════════════════════════════════════════════════════════════════════
  window.OF_applyExtractionAction = async function (documentId, action) {
    try {
      const { data, error } = await supa().functions.invoke('apply-extraction-action', {
        body: { document_id: documentId, action_key: action.key, action },
      });
      if (error) throw error;
      return data;
    } catch (err) {
      // If the edge function isn't deployed yet, log clearly but don't
      // hard-fail the UI — the page already records the click locally.
      if (err?.message?.includes('Function not found') ||
          err?.context?.status === 404) {
        console.warn('apply-extraction-action not deployed — recording click only.');
        return { ok: true, no_op: true };
      }
      throw err;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SIGNED-URL HELPER — used by the preview pane in documents.html
  //
  // documents.html stores file_url as the storage path (not a signed URL).
  // Whenever the page wants to display or open a file, it should call
  // window.OF_getSignedUrl(path) which returns a 1hr-TTL URL.
  //
  // We patch the rendering to use this if available; if you'd rather not
  // use signed URLs (e.g. you switch the bucket to public), this becomes
  // a passthrough.
  // ═══════════════════════════════════════════════════════════════════════════
  window.OF_getSignedUrl = async function (path) {
    if (!path) return null;
    // Already a full URL? Pass through.
    if (/^https?:\/\//.test(path)) return path;
    const { data, error } = await supa().storage
      .from('loan-documents').createSignedUrl(path, 3600);
    if (error) {
      console.warn('signed url failed:', error);
      return null;
    }
    return data.signedUrl;
  };

})();
