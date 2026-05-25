// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9b · documents pipeline hooks
// File: /js/of-hooks-documents.js
//
// REV 9.9c (Phase 14.0.14): storage quota reserve/release wired into OF_uploadFile.
//   ⚠ ADVISORY enforcement only. Uploads go client-direct to Storage
//     (supa.storage.upload), so this JS gate stops the UI and good-faith clients
//     from exceeding quota and gives live usage numbers — it is NOT a hard boundary
//     against a hostile client that skips the JS. For true enforcement, add a
//     storage.objects INSERT trigger or route uploads through an edge function.
//   Reserve fires AFTER local validation, BEFORE the Storage upload. On any upload
//     failure the reservation is RELEASED so a failed upload never permanently
//     consumes quota. DB dep: migrations 026 + 026b (client calls reserve_my_storage /
//     release_my_storage — JWT-scoped, cannot target another branch).
//
// Implements the four hooks that /documents.html expects:
//
//   window.OF_uploadFile(file, onProgress)
//     → uploads bytes to the 'documents' Supabase Storage bucket and
//       returns { file_url, file_size_bytes, mime_type, initial_status }.
//       file_url is the bucket PATH (not a URL); page resolves it to a
//       signed URL via OF_getSignedUrl when previewing.
//
//   window.OF_getSignedUrl(path)
//     → returns a 1hr signed URL for inline preview + "open in new tab".
//
//   window.OF_extractDocument(documentId)
//     → invokes the extract-document edge function, returns the
//       { doc_type, confidence, fields, suggested_actions } shape that
//       /documents.html renders directly.
//
//   window.OF_applyExtractionAction(documentId, action)
//     → invokes apply-extraction-action edge function to write extracted
//       data back to loans / borrowers / conditions.
//
// Wiring
// ──────
// Add this to /documents.html, somewhere after the existing
// <script src="/js/of-hooks.js"></script> line in the head:
//
//   <script src="/js/of-hooks-documents.js"></script>
//
// Or paste the body of this file into /js/of-hooks.js if you want
// everything in one place. The hooks attach to window, so source layout
// is interchangeable.
//
// Prerequisites
// ─────────────
//   1. Supabase Storage bucket named 'documents' must exist and be PRIVATE.
//      See deployment notes at the end of this file for the SQL.
//   2. Edge functions deployed:
//        supabase functions deploy extract-document
//        supabase functions deploy apply-extraction-action
//   3. ANTHROPIC_API_KEY set as a function secret:
//        supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Graceful degradation
// ────────────────────
// If any hook fails to load (e.g., script tag missing), /documents.html
// has fallback behavior built in — uploads degrade to object URLs that
// won't survive reload, extraction throws an explanatory error, apply
// just records the click. That means breaking changes here won't take
// down the page; users will see specific toasts instead.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF Docs hooks] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  // ─── Constants ───────────────────────────────────────────────────────────

  const BUCKET = 'documents';
  const ALLOWED_MIMES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/jpg',  // some browsers send this variant
  ]);
  const MAX_BYTES = 25 * 1024 * 1024;  // matches /documents.html UI text

  // If/when the malware-scanning pipeline lands, flip this to 'quarantined'.
  // The /documents.html realtime handler detects the quarantined→uploaded
  // transition and auto-fires extraction once the scanner clears the file.
  // See deferred item in build queue: "Real malware scanning on uploads".
  const INITIAL_STATUS = 'uploaded';


  // ─── OF_uploadFile ──────────────────────────────────────────────────────

  window.OF_uploadFile = async function OF_uploadFile(file, onProgress) {
    if (!file) throw new Error('No file provided.');
    if (!ALLOWED_MIMES.has(file.type)) {
      throw new Error('File type not allowed: ' + (file.type || 'unknown') + '. Use PDF, JPG, or PNG.');
    }
    if (file.size > MAX_BYTES) {
      throw new Error('File over 25MB limit (' + (file.size / 1024 / 1024).toFixed(1) + 'MB).');
    }
    if (file.size === 0) {
      throw new Error('File is empty.');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized.');

    // Resolve the current user's branch — needed for the storage path
    // prefix so RLS on the bucket can scope reads to the user's branch.
    const { data: { user }, error: userErr } = await supa.auth.getUser();
    if (userErr || !user) throw new Error('Not signed in.');

    const { data: profile, error: profErr } = await supa
      .from('profiles')
      .select('branch_id')
      .eq('id', user.id)
      .maybeSingle();
    if (profErr || !profile?.branch_id) {
      throw new Error('No branch on profile — contact your admin.');
    }

    // ─── STORAGE QUOTA RESERVE (Phase 14.0.14) ────────────────────────────
    // Advisory gate (see REV 9.9c header). Reserve the file's bytes against the
    // branch quota BEFORE uploading. If it doesn't fit, refuse with a clear
    // message. If the RPC itself errors (DB hiccup / missing migration), FAIL
    // OPEN — do not let the quota check block a legitimate upload at this stage.
    let quotaReserved = false;
    try {
      // Client-safe RPC: branch resolved from JWT server-side (cannot target another branch).
      const { data: q, error: qErr } = await supa.rpc('reserve_my_storage', {
        p_bytes: file.size,
      });
      if (qErr) {
        console.warn('[OF Docs hooks] storage quota RPC error, FAILING OPEN:', qErr.message);
      } else if (q && q.allowed === false) {
        const usedGb = (Number(q.bytes_used) / 1073741824).toFixed(2);
        const maxGb  = (Number(q.max_bytes)  / 1073741824).toFixed(2);
        if (q.reason === 'over_files') {
          throw new Error('Storage file-count limit reached for your branch (' +
            q.file_count + '/' + q.max_files + '). Remove files or contact your admin.');
        }
        throw new Error('Branch storage quota exceeded — this file would put you over ' +
          maxGb + 'GB (currently ' + usedGb + 'GB used). Remove files or contact your admin.');
      } else {
        quotaReserved = true;  // bytes are now reserved; must release if upload fails
      }
    } catch (rpcThrow) {
      // A thrown Error here is the intentional quota-exceeded refusal above —
      // re-throw it. Anything else (network) we already handled via qErr/fail-open.
      if (rpcThrow instanceof Error && /quota|limit/i.test(rpcThrow.message)) throw rpcThrow;
      console.warn('[OF Docs hooks] storage quota check threw, FAILING OPEN:', rpcThrow);
    }

    // Helper: give back a reservation if the upload doesn't complete.
    async function releaseReservation() {
      if (!quotaReserved) return;
      try {
        await supa.rpc('release_my_storage', { p_bytes: file.size });
      } catch (relErr) {
        console.warn('[OF Docs hooks] storage release failed (usage may overcount):', relErr);
      }
      quotaReserved = false;
    }

    // Path convention: <branch_id>/<uuid>.<ext>
    // Loan ID isn't in the path because uploads can target the branch
    // library (no loan), and we don't want to move files around when a
    // doc is later attached to a loan. The DB row's loan_id column is
    // the source of truth for "which loan does this belong to."
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const uuid = crypto.randomUUID();
    const path = `${profile.branch_id}/${uuid}.${ext || 'bin'}`;

    // supabase-js v2 doesn't expose upload progress. Fake it with two
    // beats — 10% on start (so the user sees motion immediately) and
    // 95% just before the upload returns. CSS transition handles the
    // smoothness; precise byte-level progress would require swapping
    // to a fetch + XHR wrapper which isn't worth the code for files
    // capped at 25MB on a domestic connection.
    if (typeof onProgress === 'function') onProgress(10);

    let uploadResult;
    try {
      uploadResult = await supa.storage.from(BUCKET).upload(path, file, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });
    } catch (err) {
      await releaseReservation();  // upload threw — give the bytes back
      throw new Error('Upload failed: ' + (err && err.message ? err.message : String(err)));
    }
    if (uploadResult.error) {
      await releaseReservation();  // upload errored — give the bytes back
      // Surface the most useful message we can. Common cases:
      //   - "new row violates row-level security policy" → bucket RLS missing
      //   - "Duplicate" → uuid collision (astronomically rare; just retry)
      //   - 413 / "Payload too large" → server-side size limit smaller than client check
      throw new Error('Upload failed: ' + uploadResult.error.message);
    }

    if (typeof onProgress === 'function') onProgress(100);

    return {
      file_url: path,  // storage PATH, not URL. /documents.html knows.
      file_size_bytes: file.size,
      mime_type: file.type,
      initial_status: INITIAL_STATUS,
    };
  };


  // ─── OF_getSignedUrl ────────────────────────────────────────────────────

  window.OF_getSignedUrl = async function OF_getSignedUrl(path) {
    if (!path) throw new Error('No path provided.');
    // Defensive: if someone passed a full URL by mistake, return it as-is
    // rather than trying to sign a URL with another URL inside it.
    if (/^https?:\/\//i.test(path)) return path;

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized.');

    const { data, error } = await supa.storage
      .from(BUCKET)
      .createSignedUrl(path, 3600);   // 1 hour TTL

    if (error) throw new Error('Signed URL failed: ' + error.message);
    if (!data?.signedUrl) throw new Error('Signed URL returned empty.');
    return data.signedUrl;
  };


  // ─── OF_extractDocument ─────────────────────────────────────────────────

  window.OF_extractDocument = async function OF_extractDocument(documentId) {
    if (!documentId) throw new Error('No documentId provided.');

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized.');

    const { data, error } = await supa.functions.invoke('extract-document', {
      body: { document_id: documentId },
    });

    if (error) {
      const msg = error.message || 'Extraction function failed';
      throw new Error(msg);
    }
    if (!data) throw new Error('Extraction returned no data.');
    if (data.ok === false) throw new Error(data.error || 'Extraction returned an error.');

    return {
      doc_type: data.doc_type,
      confidence: data.confidence,
      fields: Array.isArray(data.fields) ? data.fields : [],
      suggested_actions: Array.isArray(data.suggested_actions) ? data.suggested_actions : [],
    };
  };


  // ─── OF_applyExtractionAction ───────────────────────────────────────────

  window.OF_applyExtractionAction = async function OF_applyExtractionAction(documentId, action) {
    if (!documentId) throw new Error('No documentId provided.');
    if (!action || typeof action !== 'object' || !action.key) {
      throw new Error('Invalid action — must have a "key" property.');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized.');

    const { data, error } = await supa.functions.invoke('apply-extraction-action', {
      body: {
        document_id: documentId,
        action_key: action.key,
        // The whole action object goes along. The edge function reads
        // action_payload if the extractor included structured data
        // (e.g. monthly_income_cents on a write_income action).
        action_payload: action.payload || null,
        action_label: action.label || null,
      },
    });

    if (error) throw new Error(error.message || 'Apply failed');
    if (!data) throw new Error('Apply returned no data.');
    if (data.ok === false) throw new Error(data.error || 'Action returned an error.');
    return data;
  };


  // Version stamps — useful for "is the right hook loaded?" debugging.
  window.OF_uploadFile.version             = '9.9c';
  window.OF_getSignedUrl.version           = '9.9b';
  window.OF_extractDocument.version        = '9.9b';
  window.OF_applyExtractionAction.version  = '9.9b';
})();


// ═══════════════════════════════════════════════════════════════════════════
// DEPLOYMENT NOTES
//
// 1. Storage bucket. Run once in SQL editor:
//
//      insert into storage.buckets (id, name, public)
//      values ('documents', 'documents', false)
//      on conflict (id) do nothing;
//
//      -- RLS: only same-branch members can read/write files in their
//      -- branch's prefix. The path convention is <branch_id>/<uuid>.<ext>,
//      -- so the prefix check enforces branch isolation.
//      create policy "documents_branch_read"
//        on storage.objects for select
//        using (
//          bucket_id = 'documents'
//          and (storage.foldername(name))[1] = (
//            select branch_id::text from public.profiles where id = auth.uid()
//          )
//        );
//
//      create policy "documents_branch_write"
//        on storage.objects for insert
//        with check (
//          bucket_id = 'documents'
//          and (storage.foldername(name))[1] = (
//            select branch_id::text from public.profiles where id = auth.uid()
//          )
//          and (select role from public.profiles where id = auth.uid()) <> 'viewer'
//        );
//
// 2. Edge function secrets. From the project root:
//
//      supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
//    The two functions in this patch read it via Deno.env.get(). Service
//    role key + URL are auto-injected by Supabase.
//
// 3. Deploy functions:
//
//      supabase functions deploy extract-document
//      supabase functions deploy apply-extraction-action
//
// 4. Storage quota (Phase 14.0.14). Run migration 026_storage_quota.sql.
//    Advisory only at this layer — see REV 9.9c header. For HARD enforcement,
//    add a storage.objects INSERT trigger that calls check_and_reserve_storage
//    and raises on a false verdict, OR route uploads through an edge function.
//    NOTE: usage is reserve-on-upload going forward; it does NOT backfill bytes
//    already in the bucket. To seed current usage, sum existing storage.objects
//    sizes per branch prefix into storage_usage once.
//
// 5. Verify end-to-end. Upload a PDF paystub via /documents.html. You
//    should see:
//    a. file appear in the list within ~1s with status='uploaded'
//    b. status flip to 'extracting' immediately after upload
//    c. status flip to 'extracted' once Claude Vision returns (~5-15s)
//    d. fields panel populated with employer / pay period / income
//    e. "Write $X/mo income to loan" action visible if loan_id set
// ═══════════════════════════════════════════════════════════════════════════
