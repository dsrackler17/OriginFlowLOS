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
     window.OF_uploadBorrowerDocument(file, requestId)  — borrower doc upload
                                   (ADDED 2026-05-24; REVISED same day against
                                   the real process-document/index.ts — see the
                                   block above the function for what changed)

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

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------
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

    // Storage bucket for borrower uploads. CONFIRMED against
    // process-document/index.ts (const STORAGE_BUCKET = 'loan-documents').
    UPLOAD_BUCKET: 'loan-documents',
  }, window.OF_CONFIG || {});

  if (!CONFIG.SUBMIT_APPLICATION_URL) {
    CONFIG.SUBMIT_APPLICATION_URL =
      CONFIG.SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co') +
      '/submit-application';
  }

  // ---------------------------------------------------------------------------
  // SUPABASE CLIENT SINGLETON
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // OF_bootstrap()
  //   Resolves the current borrower + their active loan. Three outcomes:
  //   1. No session                -> redirect to sign-in, return null
  //   2. Session, no linked borrower -> call link_auth_user_to_borrower RPC
  //                                    using borrower_id from user_metadata
  //                                    (this is the first-sign-in case)
  //   3. Session + linked borrower  -> fetch borrower + most recent active loan
  //
  //   Returns: { session, borrower, loan }
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // OF_touchLastSeen() — convenience for portal pages that want to ping
  // last_seen_at without going through full bootstrap. Fire-and-forget.
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // OF_signOut()
  // ---------------------------------------------------------------------------
  async function signOut() {
    const sb = getClient();
    if (sb) await sb.auth.signOut();
    window.location.href = CONFIG.SIGN_IN_URL;
  }
  window.OF_signOut = signOut;

  // ---------------------------------------------------------------------------
  // OF_submitApplication(payload)
  //   The /apply.html form posts here. Called UNAUTHENTICATED — this is
  //   the only hook that doesn't require a session.
  //
  //   Returns: { success, masked_email, loan_number, is_new_borrower }
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // OF_signInWithEmail(email)
  //   Sends a magic link to an existing borrower (returning-user flow).
  //   The portal_signin.html page calls this.
  //
  //   The emailRedirectTo lands on PORTAL_HOME_URL (flat-path
  //   /portal_index.html by default). portal_index then runs OF_bootstrap
  //   which handles the post-magic-link session pickup.
  // ---------------------------------------------------------------------------
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
     OF_uploadBorrowerDocument(file, requestId)
       ADDED 2026-05-24. REVISED same day against the REAL
       process-document/index.ts (Rev 3). What the function actually told us:

         CONFIRMED
           - Matcher reads `loan_documents` (NOT a separate `documents` table).
           - Storage bucket is 'loan-documents'; storage column is `storage_path`.
           - Processing is gated on status = 'uploaded'.

         FIXED vs the first cut
           - mime_type is now set. process-document does
             buildContentBlock(doc.mime_type, ...); with no mime_type the doc is
             rejected as "unsupported MIME" before any AI runs. This was fatal.
           - Dropped the bogus `document_type` column write + the
             required_doc_type lookup. There is NO document_type column; routing
             is by `ai_classified_doc_type`, which process-document sets itself
             via its Haiku classify step. We must not pre-set it.
           - branch_id + borrower_id are now populated (process-document types
             them non-null; used for ai_extraction_runs logging + the income
             discrepancy condition insert).
           - REMOVED the client-side process-document invoke. The function
             authenticates by matching Authorization: Bearer <WEBHOOK_SECRET> —
             a server-only secret. A borrower client must never hold it, so the
             client cannot and must not call process-document directly.

     HOW PROCESSING IS FIRED
       Server-side only: a DB trigger / database webhook on loan_documents
       INSERT (status='uploaded') calls process-document with the WEBHOOK_SECRET
       it reads from Vault. See migration `021_fire_process_document_on_upload`.
       >>> If that trigger is not installed, this row persists + shows in the UI
           but NOTHING processes it and no condition auto-clears. That trigger is
           the thesis link. <<<

     CONTRACT (matches portal_docs.html -> uploadFiles()):
       file:      File from <input>/DataTransfer
       requestId: the CONDITION row id (uuid) being satisfied, or null for the
                  "Something else?" extra upload (LO triage).
       returns:   { documentId, conditionId }   (throws on failure)
     ========================================================================= */

  // CONFIRMED: matcher consumes loan_documents (process-document SELECT).
  const INSERT_TABLE = 'loan_documents';

  function _safeName(name) {
    return String(name || 'upload').replace(/[^\w.\-]+/g, '_').slice(-120);
  }

  // Resolve + cache branch_id (from the loan) and the uploader's borrower_id.
  // process-document needs both on the row. Cached on OF_DOCS_CTX so repeat
  // uploads in the same session don't re-query.
  async function _resolveOwnership(sb, loanId) {
    const ctx = window.OF_DOCS_CTX || (window.OF_DOCS_CTX = {});
    if (ctx._branchId !== undefined && ctx._borrowerId !== undefined) {
      return { branchId: ctx._branchId, borrowerId: ctx._borrowerId };
    }

    let branchId = (ctx.loan && ctx.loan.branch_id) || null;
    if (!branchId) {
      const { data: loan, error } = await sb
        .from('loans').select('branch_id').eq('id', loanId).maybeSingle();
      if (error) console.warn('[portal-auth] branch_id lookup failed:', error.message);
      branchId = (loan && loan.branch_id) || null;
    }

    let borrowerId = null;
    try {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: b, error } = await sb
          .from('borrowers').select('id').eq('auth_user_id', user.id).maybeSingle();
        if (error) console.warn('[portal-auth] borrower_id lookup failed:', error.message);
        borrowerId = (b && b.id) || null;
      }
    } catch (e) {
      console.warn('[portal-auth] getUser failed during upload ownership resolve:', e && e.message);
    }

    ctx._branchId = branchId;
    ctx._borrowerId = borrowerId;
    return { branchId, borrowerId };
  }

  async function uploadBorrowerDocument(file, requestId) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase client unavailable');

    const docsCtx = window.OF_DOCS_CTX;
    const loanId = docsCtx && docsCtx.loan && docsCtx.loan.id;
    if (!loanId) throw new Error('No loan context — cannot attach upload');

    const conditionId = requestId || null;   // null = extra (unclassified) upload
    const { branchId, borrowerId } = await _resolveOwnership(sb, loanId);

    // 1) STORE the bytes (bucket confirmed = 'loan-documents').
    const objectPath = `${loanId}/${conditionId || 'misc'}/${Date.now()}_${_safeName(file.name)}`;
    const { error: upErr } = await sb.storage
      .from(CONFIG.UPLOAD_BUCKET)
      .upload(objectPath, file, {
        upsert: false,
        contentType: file.type || undefined,
      });
    if (upErr) throw new Error('Storage upload failed: ' + upErr.message);

    // 2) PERSIST the row. Columns chosen to match process-document's SELECT.
    //    CRITICAL: mime_type drives the server-side content block; status MUST
    //    be 'uploaded' (the gate process-document checks). We deliberately do
    //    NOT set a doc_type — process-document classifies it itself.
    const row = {
      loan_id:         loanId,
      branch_id:       branchId,           // ai_extraction_runs + discrepancy inserts
      borrower_id:     borrowerId,         // uploader
      condition_id:    conditionId,        // UI linkage only; matcher routes by template_key
      filename:        file.name,
      file_size_bytes: file.size,
      mime_type:       file.type || null,  // CRITICAL: buildContentBlock() needs this
      storage_path:    objectPath,
      status:          'uploaded',         // the processing gate
    };
    const { data: inserted, error: insErr } = await sb
      .from(INSERT_TABLE)
      .insert(row)
      .select('id')
      .single();
    if (insErr) {
      // Surface the raw Postgres message — act+flag: let a wrong column/enum
      // guess fail loudly at runtime rather than pre-validating every column.
      throw new Error(`Document insert into ${INSERT_TABLE} failed: ` + insErr.message);
    }

    // 3) NO client-side process-document call by design (WEBHOOK_SECRET is
    //    server-only). The INSERT above is the trigger surface; the DB
    //    trigger / database webhook fires process-document server-side.
    return { documentId: inserted && inserted.id, conditionId };
  }
  window.OF_uploadBorrowerDocument = uploadBorrowerDocument;

})();
