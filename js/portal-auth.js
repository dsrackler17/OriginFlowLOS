/* =============================================================================
   /js/portal-auth.js
   ---------------------------------------------------------------------------
   Shared frontend module loaded by every portal page. Provides:

     window.OF_supabase()        — singleton Supabase client (loads UMD if needed)
     window.OF_bootstrap()       — resolves session → borrower → loan,
                                   returns { session, borrower, loan }
     window.OF_signOut()         — clears session + redirects to /portal_signin.html
     window.OF_submitApplication(payload)  — public /apply.html submit hook
     window.OF_signInWithEmail(email)      — magic-link for returning users
     window.OF_uploadBorrowerDocument(file, requestId)  — borrower doc upload +
                                   process-document trigger  (ADDED 2026-05-24,
                                   Phase 11.5.11 → 12.5.9 chain link)

   Inclusion pattern in each portal HTML:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="/js/portal-auth.js"></script>
     <script>
       (async () => {
         const ctx = await window.OF_bootstrap();
         if (!ctx) return;   // OF_bootstrap handles redirect if signed out
         renderPage(ctx);
       })();
     </script>

   apply.html (the public landing) is the EXCEPTION — it doesn't call
   OF_bootstrap because the user isn't signed in yet. It only calls
   OF_submitApplication.

   Environment:
     This module reads SUPABASE_URL + SUPABASE_ANON_KEY from window.OF_CONFIG
     which the host page populates before loading this module. CONFIG
     defaults below match the production Submarine Catalyst project so the
     module is usable standalone — but the host page should still set
     OF_CONFIG for environment-specific overrides.

   Path conventions:
     URLs use the flat-filename layout (e.g. /portal_signin.html, NOT
     /portal/sign-in.html) to match the GitHub Pages repo structure.
     ============================================================================= */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────────────────────────────────
  const CONFIG = Object.assign({
    // Override these on window.OF_CONFIG before this script loads. The
    // defaults here match the Submarine Catalyst production project so the
    // module is usable standalone (e.g. on a page that forgot to set
    // OF_CONFIG).
    SUPABASE_URL:        'https://zgmwtslzsmtmqcivngdq.supabase.co',
    SUPABASE_ANON_KEY:   'sb_publishable_1NED7PleUmnkJH_zVM3mlg_g_KBINng',
    // Endpoint paths. Override to point at a different project.
    SUBMIT_APPLICATION_URL: null,  // computed from SUPABASE_URL if null
    // Sign-in landing route — flat filename to match repo layout.
    SIGN_IN_URL: '/portal_signin.html',
    // Portal home — flat filename to match repo layout.
    PORTAL_HOME_URL: '/portal_index.html',

    // ── ADDED 2026-05-24 — document-upload config ───────────────────────────
    // ASSUMPTION (CONFIRM): the Storage bucket that holds borrower uploads.
    // Guessing 'loan-documents'. Verify the real bucket id in the Supabase
    // dashboard → Storage. If it differs, override on window.OF_CONFIG.
    UPLOAD_BUCKET: 'loan-documents',
    // The edge function that runs extraction + the DSL matcher. Confirmed
    // deployed on prod per handoff (process-document, rewritten this cycle).
    PROCESS_DOCUMENT_FN: 'process-document',
  }, window.OF_CONFIG || {});

  if (!CONFIG.SUBMIT_APPLICATION_URL) {
    CONFIG.SUBMIT_APPLICATION_URL =
      CONFIG.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') +
      '/submit-application';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUPABASE CLIENT SINGLETON
  // ─────────────────────────────────────────────────────────────────────────
  let _client = null;
  function getClient() {
    if (_client) return _client;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      console.error('[portal-auth] supabase-js UMD not loaded. Include https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2 before this script.');
      return null;
    }
    _client = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession:   true,
          autoRefreshToken: true,
          detectSessionInUrl: true,   // critical — picks up #access_token=... from magic-link redirects
        },
      }
    );
    return _client;
  }
  window.OF_supabase = getClient;

  // ─────────────────────────────────────────────────────────────────────────
  // OF_bootstrap()
  //   Resolves the current borrower + their active loan. Three outcomes:
  //   1. No session                → redirect to sign-in, return null
  //   2. Session, no linked borrower → call link_auth_user_to_borrower RPC
  //                                    using borrower_id from user_metadata
  //                                    (this is the first-sign-in case)
  //   3. Session + linked borrower  → fetch borrower + most recent active loan
  //
  //   Returns: { session, borrower, loan }
  // ─────────────────────────────────────────────────────────────────────────
  async function bootstrap() {
    const sb = getClient();
    if (!sb) return null;

    // Get session — supabase-js auto-detects the access_token in the URL hash
    const { data: { session }, error: sessionError } = await sb.auth.getSession();
    if (sessionError) console.warn('[portal-auth] getSession error:', sessionError);

    if (!session) {
      // Not signed in — redirect to sign-in, preserve the current URL
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `${CONFIG.SIGN_IN_URL}?return_to=${returnTo}`;
      return null;
    }

    // Try to find a linked borrower for this auth user
    let { data: borrower, error: borrowerError } = await sb
      .from('borrowers')
      .select('id, first_name, last_name, email, phone, branch_id, verified_at')
      .eq('auth_user_id', session.user.id)
      .maybeSingle();

    if (borrowerError) {
      console.error('[portal-auth] borrower lookup failed:', borrowerError);
      return null;
    }

    // First-sign-in case: no linked borrower yet. Read borrower_id from the
    // user_metadata that submit-application stamped, and link.
    if (!borrower) {
      const meta = session.user.user_metadata || {};
      if (!meta.borrower_id) {
        // No metadata, no linked row — this user signed in but isn't a
        // borrower yet. Probably an LO trying to use the borrower portal.
        // Redirect to LO dashboard (or wherever) — for now just sign out.
        console.warn('[portal-auth] auth user has no borrower_id metadata and no linked borrower row');
        await sb.auth.signOut();
        window.location.href = CONFIG.SIGN_IN_URL + '?error=not_a_borrower';
        return null;
      }

      const { data: linkResult, error: linkError } = await sb.rpc(
        'link_auth_user_to_borrower',
        { p_borrower_id: meta.borrower_id, p_auth_user_id: session.user.id }
      );

      if (linkError) {
        console.error('[portal-auth] link RPC failed:', linkError);
        // Common cause: email mismatch (someone shared a magic link). Show error.
        window.location.href = CONFIG.SIGN_IN_URL + '?error=link_failed';
        return null;
      }

      // Re-fetch borrower row now that link is established
      const reread = await sb
        .from('borrowers')
        .select('id, first_name, last_name, email, phone, branch_id, verified_at')
        .eq('id', linkResult.borrower_id)
        .single();
      borrower = reread.data;
    }

    if (!borrower) {
      console.error('[portal-auth] could not resolve borrower row after link attempt');
      await sb.auth.signOut();
      window.location.href = CONFIG.SIGN_IN_URL;
      return null;
    }

    // Touch last_seen_at (RPC handles auth-uid-to-borrower lookup internally;
    // fire-and-forget, don't block the page load on it)
    sb.rpc('touch_borrower_last_seen').then(() => {}, (err) => {
      console.warn('[portal-auth] touch last_seen failed:', err);
    });

    // Fetch loan IDs this borrower is on
    const { data: loanLinks, error: linksError } = await sb
      .from('loan_borrowers')
      .select('loan_id')
      .eq('borrower_id', borrower.id);
    if (linksError) {
      console.warn('[portal-auth] loan_borrowers lookup failed:', linksError);
    }
    const loanIds = (loanLinks || []).map(r => r.loan_id);

    let loan = null;
    if (loanIds.length > 0) {
      // Fetch the most recent active loan + the assigned LO
      const { data: loanRow, error: loanError } = await sb
        .from('loans')
        .select(`
          id, loan_number, status, intake_source,
          purpose, property_type, occupancy,
          loan_amount_cents, purchase_price_cents,
          property_address, rate_bps, term_months, branch_id,
          lo:profiles!lo_id ( id, full_name, email, phone )
        `)
        .in('id', loanIds)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (loanError) {
        console.warn('[portal-auth] loan lookup failed (non-fatal):', loanError);
      } else {
        loan = loanRow;
      }
    }

    return {
      session,
      borrower,
      loan,
    };
  }
  window.OF_bootstrap = bootstrap;

  // ─────────────────────────────────────────────────────────────────────────
  // OF_touchLastSeen() — convenience for portal pages that want to ping
  // last_seen_at without going through full bootstrap. Fire-and-forget.
  // ─────────────────────────────────────────────────────────────────────────
  async function touchLastSeen() {
    const sb = getClient();
    if (!sb) return;
    try {
      await sb.rpc('touch_borrower_last_seen');
    } catch (err) {
      console.warn('[portal-auth] touch_borrower_last_seen:', err);
    }
  }
  window.OF_touchLastSeen = touchLastSeen;

  // ─────────────────────────────────────────────────────────────────────────
  // OF_signOut()
  // ─────────────────────────────────────────────────────────────────────────
  async function signOut() {
    const sb = getClient();
    if (sb) await sb.auth.signOut();
    window.location.href = CONFIG.SIGN_IN_URL;
  }
  window.OF_signOut = signOut;

  // ─────────────────────────────────────────────────────────────────────────
  // OF_submitApplication(payload)
  //   The /apply.html form posts here. Called UNAUTHENTICATED — this is
  //   the only hook that doesn't require a session.
  //
  //   Returns: { success, masked_email, loan_number, is_new_borrower }
  // ─────────────────────────────────────────────────────────────────────────
  async function submitApplication(payload) {
    const res = await fetch(CONFIG.SUBMIT_APPLICATION_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        // Anon key required for Supabase edge function gateway, even
        // though our function itself doesn't require auth.
        'apikey':        CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const err = new Error(data.error || `Submission failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  window.OF_submitApplication = submitApplication;

  // ─────────────────────────────────────────────────────────────────────────
  // OF_signInWithEmail(email)
  //   Sends a magic link to an existing borrower (returning-user flow).
  //   The portal_signin.html page calls this.
  //
  //   The emailRedirectTo lands on PORTAL_HOME_URL (flat-path
  //   /portal_index.html by default). portal_index then runs OF_bootstrap
  //   which handles the post-magic-link session pickup.
  // ─────────────────────────────────────────────────────────────────────────
  async function signInWithEmail(email) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase client unavailable');
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin + CONFIG.PORTAL_HOME_URL,
      },
    });
    if (error) throw error;
    return { sent: true };
  }
  window.OF_signInWithEmail = signInWithEmail;

  /* ===========================================================================
     OF_uploadBorrowerDocument(file, requestId)        [ADDED 2026-05-24]
     -------------------------------------------------------------------------
     THE THESIS LINK. portal_docs.html → uploadFiles() already calls this hook;
     until now it was never defined, so every borrower upload silently took the
     in-memory stub path (600ms fake delay, no persistence, matcher never fired).
     This is the real implementation: store the file, persist the row, and kick
     the extraction+DSL-matcher (process-document) so the borrower upload can
     auto-clear its condition — "95% in OriginFlow, never open Encompass."

     CONTRACT (matches the call site):
       file:      a File from <input>/DataTransfer
       requestId: the CONDITION row id (uuid) the borrower is satisfying, or
                  null for the "Something else?" extra-upload (LO triage).
       returns:   { documentId, documentType, conditionId }   (throws on failure)

     ───────────────────────────────────────────────────────────────────────
     THREE UNVERIFIED ASSUMPTIONS baked in — confirm against prod, then prune:

       [A1] INSERT TARGET TABLE.  This page READS `loan_documents`
            (filename/file_size_bytes/status), so we WRITE there too, so the UI
            reflects the upload. BUT the first verified auto-clear used a
            `documents` row (…07000001, populated `extraction_data`, col
            `file_name`). If `documents` and `loan_documents` are DISTINCT
            tables and the matcher reads `documents`, this insert feeds the UI
            but NOT the matcher → chain stays broken. CONFIRM whether
            loan_documents and documents are the same table / a view / distinct.
            If the matcher consumes `documents`, repoint INSERT_TABLE below.

       [A2] PROCESSING TRIGGER MECHANISM.  Either (a) an AFTER INSERT trigger on
            the docs table fires process-document via pg_net (then the insert
            alone is enough and the explicit invoke below is redundant/harmless),
            or (b) no trigger and the client must invoke process-document. Per
            handoff §4, edge fns needing service_role CANNOT be called with this
            publishable/anon key — so if process-document requires service_role,
            path (b) will 401 and path (a) is mandatory. We do BOTH and fail the
            invoke soft. CONFIRM which is real and delete the dead one.

       [A3] COLUMN + BUCKET NAMES.  Storage bucket = CONFIG.UPLOAD_BUCKET
            ('loan-documents', guessed). Storage-path column = `storage_path`
            (guessed). We assume `document_type` lives on the docs table. The
            process-document body shape ({document_id, loan_id, document_type,
            condition_id}) is a guess — match it to process-document/index.ts.
     ========================================================================= */

  // [A1] Repoint this if the matcher consumes a different table than the UI reads.
  const INSERT_TABLE = 'loan_documents';

  function _safeName(name) {
    return String(name || 'upload').replace(/[^\w.\-]+/g, '_').slice(-120);
  }

  async function _resolveDocType(sb, conditionId) {
    // The matcher's routing key. `required_doc_type` was backfilled onto
    // conditions this session from match_criteria->any_of->0->doc_type, aliased
    // to the document_type enum. Read it so process-document routes the doc to
    // the right extractor/rules. Null is fine for extra (unclassified) uploads.
    if (!conditionId) return null;
    const { data, error } = await sb
      .from('conditions')
      .select('id, required_doc_type')
      .eq('id', conditionId)
      .maybeSingle();
    if (error) {
      console.warn('[portal-auth] required_doc_type lookup failed (doc will be unrouted):', error.message);
      return null;
    }
    return (data && data.required_doc_type) || null;
  }

  async function _triggerProcessing(sb, payload) {
    // [A2] path (b): explicit invoke. Fails SOFT — a non-2xx (e.g. 401 from an
    // insufficient anon key) just means path (a)'s DB trigger is the real
    // mechanism and already did the work on INSERT.
    try {
      const { error } = await sb.functions.invoke(CONFIG.PROCESS_DOCUMENT_FN, {
        body: payload,  // [A3] confirm shape vs process-document/index.ts
      });
      if (error) {
        console.warn('[portal-auth] process-document invoke non-OK ' +
          '(fine if a DB trigger handles processing on insert):', error.message || error);
      }
    } catch (e) {
      console.warn('[portal-auth] process-document invoke threw ' +
        '(fine if trigger-driven):', e && e.message);
    }
  }

  async function uploadBorrowerDocument(file, requestId) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase client unavailable');

    // Loan context — prefer the page-stashed ctx so we don't re-bootstrap.
    const docsCtx = window.OF_DOCS_CTX;
    const loanId = docsCtx && docsCtx.loan && docsCtx.loan.id;
    if (!loanId) throw new Error('No loan context — cannot attach upload');

    const conditionId  = requestId || null;            // null = extra upload
    const documentType = await _resolveDocType(sb, conditionId);

    // 1) STORE the bytes. [A3] bucket name is an assumption.
    const objectPath = `${loanId}/${conditionId || 'misc'}/${Date.now()}_${_safeName(file.name)}`;
    const { error: upErr } = await sb.storage
      .from(CONFIG.UPLOAD_BUCKET)
      .upload(objectPath, file, {
        upsert: false,
        contentType: file.type || undefined,
      });
    if (upErr) throw new Error('Storage upload failed: ' + upErr.message);

    // 2) PERSIST the row. [A1] target table / [A3] column names are assumptions.
    //    Column set matches what portal_docs.html's SELECT already reads back
    //    (filename, file_size_bytes, status) plus the routing key + storage path.
    const row = {
      loan_id:         loanId,
      condition_id:    conditionId,     // null for extra uploads
      filename:        file.name,
      file_size_bytes: file.size,
      document_type:   documentType,    // [A3] routing key; null when unclassified
      storage_path:    objectPath,      // [A3] confirm column name
      status:          'uploaded',
    };
    const { data: inserted, error: insErr } = await sb
      .from(INSERT_TABLE)
      .insert(row)
      .select('id')
      .single();
    if (insErr) {
      // Surface the real Postgres message — under the act+flag philosophy we let
      // the runtime correct our schema guesses (missing column / bad enum / etc.).
      throw new Error(`Document insert into ${INSERT_TABLE} failed: ` + insErr.message);
    }
    const documentId = inserted && inserted.id;

    // 3) TRIGGER extraction + DSL matcher. [A2] redundant-but-harmless if a DB
    //    trigger already fired on the INSERT above.
    await _triggerProcessing(sb, {
      document_id:   documentId,
      loan_id:       loanId,
      document_type: documentType,
      condition_id:  conditionId,
    });

    return { documentId, documentType, conditionId };
  }
  window.OF_uploadBorrowerDocument = uploadBorrowerDocument;

})();
