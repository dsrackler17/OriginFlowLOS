// ═══════════════════════════════════════════════════════════════════════════
// /js/of-hooks.js — OriginFlow LOS hook implementations
//
// Load BEFORE pages that depend on these globals:
//   <script src="/js/of-hooks.js"></script>
//
// ─── ROUND 2 hooks (documents pipeline) ────────────────────────────────────
//   • window.OF_uploadFile          — Supabase Storage upload + scan kick
//   • window.OF_extractDocument     — invokes extract-document edge function
//                                     (Claude Opus 4.7 vision)
//   • window.OF_applyExtractionAction — invokes apply-extraction-action
//   • window.OF_getSignedUrl        — 1hr signed URL for previews
//
// ─── ROUND 4 hooks (eSign + disclosures) ───────────────────────────────────
//   • window.OF_sendForESign        — generates LE/CD PDF, uploads, dispatches
//                                     to Dropbox Sign via dispatch-esign edge fn
//
// Pages that use eSign also need /js/disclosure-pdf.js available; this file
// will lazy-load it from the same origin if it isn't already on window. No
// HTML changes required.
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. SEND FOR ESIGN — Round 4
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Called from loan.html's promptESign() when the LO clicks "Send for
  // eSign". Generates the disclosure PDF, uploads it to the loan-documents
  // bucket, registers a documents row (so it's visible in the Documents
  // tab), and invokes the dispatch-esign edge function to hand it off to
  // Dropbox Sign.
  //
  // After this resolves, the borrower(s) get an email from Dropbox Sign
  // and the loan workspace's realtime listener (on esign_envelopes)
  // surfaces status updates as they sign.
  //
  // Input shape (matches what loan.html promptESign passes):
  //   { loanId: '<uuid>', package_type: 'initial_disclosures' | 'revised_le'
  //                                     | 'cd' | 'closing_docs' }
  //
  // Resolves with:
  //   { envelope_id, vendor_envelope_id, signers: [...], test_mode }
  //
  // Throws on any failure with a human-readable message — loan.html shows
  // these in the toast.
  // ═══════════════════════════════════════════════════════════════════════════

  const VALID_PACKAGE_TYPES = ['initial_disclosures', 'revised_le', 'cd', 'closing_docs'];

  window.OF_sendForESign = async function (opts) {
    const opts_ = opts || {};
    const loanId = opts_.loanId;
    const kind = opts_.package_type;

    if (!loanId) throw new Error('loanId is required');
    if (!kind || !VALID_PACKAGE_TYPES.includes(kind)) {
      throw new Error('package_type must be one of: ' + VALID_PACKAGE_TYPES.join(', '));
    }

    // 1. Lazy-load disclosure-pdf.js if it isn't already on window. Lets
    //    pages opt into eSign without adding another <script> tag.
    await ensureDisclosureModuleLoaded();

    // 2. Pull everything OFDisclosure needs: loan, borrowers, fees,
    //    pricing, branch. One round-trip-per-table because Supabase's
    //    nested-select syntax doesn't span unrelated tables in a single
    //    query (loans → borrowers via FK works; fees+pricing+branch don't).
    const data = await fetchDisclosureData(loanId);

    // 3. Generate the right PDF for this package type. The CD and full
    //    closing-docs generators don't exist yet; they're scoped for the
    //    closing workflow turn.
    const pdfBytes = await generatePackagePdf(kind, data);
    if (!pdfBytes || pdfBytes.length === 0) {
      throw new Error('PDF generation returned empty bytes');
    }

    // 4. Upload the source PDF to storage. Same bucket, same RLS, same
    //    path convention as user-uploaded docs (`<branch>/<loan>/<file>`).
    const sourcePath = await uploadDisclosurePdf(pdfBytes, data, kind);

    // 5. Insert a documents row pointing at the source PDF. Lets the
    //    lender see what was sent in the Documents tab. Upload bypasses
    //    the malware scanner — Dropbox Sign isn't going to receive a
    //    PDF we generated and need to scan ourselves.
    try {
      await registerDisclosureDocument(sourcePath, pdfBytes.length, data, kind);
    } catch (err) {
      // Non-fatal — the dispatch can proceed, but log so we know.
      console.warn('OF_sendForESign: documents row insert failed (non-fatal):', err);
    }

    // 6. Hand off to dispatch-esign. It does the actual Dropbox Sign API
    //    call, persists esign_envelopes + esign_signers, and returns
    //    envelope info.
    const { data: dispatchResult, error: dispatchErr } = await supa()
      .functions.invoke('dispatch-esign', {
        body: {
          loan_id: loanId,
          kind,
          source_pdf_path: sourcePath,
          // Default subject/message live in the edge function; pass
          // overrides here if a future caller wants to customize.
        },
      });

    if (dispatchErr) {
      // supabase-js wraps non-2xx as an error with .context for the body.
      let msg = dispatchErr.message || 'dispatch-esign failed';
      try {
        if (dispatchErr.context) {
          const body = await dispatchErr.context.json();
          if (body?.error) msg = body.error;
        }
      } catch (_) { /* ignore */ }
      throw new Error('eSign dispatch failed: ' + msg);
    }

    if (!dispatchResult || !dispatchResult.envelope_id) {
      throw new Error('dispatch-esign returned no envelope_id — check the function logs');
    }

    return dispatchResult;
  };

  // ─── eSign helpers ─────────────────────────────────────────────────────────

  // Pull all the data OFDisclosure needs to render the LE / CD / etc.
  // Mirrors the loan.html bootstrap query but adds fees, pricing, and
  // branch in separate parallel queries since they're not on FK paths
  // from `loans`.
  async function fetchDisclosureData(loanId) {
    const client = supa();

    // ── loan + borrowers + LO (FK joins from `loans`) ──
    const loanQ = client.from('loans')
      .select(`
        id, loan_number, branch_id, status,
        loan_amount_cents, dti_back_pct, ltv_pct, cltv_pct,
        rate_bps, term_months, program, occupancy, property_type, purpose,
        property_address, appraised_value_cents, purchase_price_cents,
        lock_expires_at, le_sent_at, cd_sent_at, intent_to_proceed_at,
        lo_id, lo:profiles!lo_id ( id, full_name, email ),
        borrowers:loan_borrowers (
          position,
          borrower:borrowers!borrower_id ( id, first_name, last_name, email, phone )
        )
      `)
      .eq('id', loanId)
      .maybeSingle();

    // ── fees (Round 4 fees table; tolerate it missing) ──
    const feesQ = client.from('fees')
      .select('id, section, description, payee, tolerance_bucket, is_pfc, ' +
              'borrower_paid_at_closing_cents, borrower_paid_before_closing_cents, ' +
              'seller_paid_at_closing_cents, seller_paid_before_closing_cents, ' +
              'paid_by_others_cents, le_amount_cents, le_snapshot_at')
      .eq('loan_id', loanId)
      .is('archived_at', null)
      .order('section', { ascending: true })
      .order('created_at', { ascending: true });

    // ── pricing scenario (latest locked, else latest) ──
    const pricingQ = client.from('pricing_scenarios')
      .select('rate_bps, points, monthly_pi_cents, total_cost_cents, locked_at, created_at')
      .eq('loan_id', loanId)
      .order('locked_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Run queries in parallel to keep the round-trip cost flat.
    const [loanRes, feesRes, pricingRes] = await Promise.allSettled([loanQ, feesQ, pricingQ]);

    // Loan must succeed; the others are best-effort.
    if (loanRes.status !== 'fulfilled' || loanRes.value.error || !loanRes.value.data) {
      const err = loanRes.status === 'fulfilled' ? loanRes.value.error : loanRes.reason;
      throw new Error('Loan fetch failed: ' + (err?.message || 'not found'));
    }
    const loan = loanRes.value.data;

    let fees = [];
    if (feesRes.status === 'fulfilled' && !feesRes.value.error) {
      fees = feesRes.value.data || [];
    } else if (feesRes.status === 'fulfilled' && feesRes.value.error) {
      // Likely the fees table doesn't exist yet — non-fatal, LE just
      // shows empty fee sections. Log so the cause is visible.
      console.warn('fees fetch failed (using empty array):', feesRes.value.error.message);
    }

    let pricing = null;
    if (pricingRes.status === 'fulfilled' && !pricingRes.value.error) {
      pricing = pricingRes.value.data;
    }

    // ── branch info (separate from loan because we need NMLS / license fields) ──
    let branch = null;
    {
      const { data: br, error: brErr } = await client.from('branches')
        .select('id, name, nmls_id, license_number, address')
        .eq('id', loan.branch_id)
        .maybeSingle();
      if (brErr) {
        console.warn('branch fetch failed (using minimal):', brErr.message);
      }
      branch = br || { id: loan.branch_id, name: 'Your Branch' };
    }

    // ── shape the data for OFDisclosure ──
    // OFDisclosure wants borrowers as a flat array (not the loan_borrowers
    // join shape), so unwrap. Sort by position so the primary borrower is
    // first.
    const borrowers = (loan.borrowers || [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(lb => lb.borrower)
      .filter(Boolean);

    return {
      loan_number: loan.loan_number,
      loan_amount_cents: loan.loan_amount_cents,
      rate_bps: loan.rate_bps,
      term_months: loan.term_months,
      program: loan.program,
      purpose: loan.purpose,
      occupancy: loan.occupancy,
      property_type: loan.property_type,
      property_address: loan.property_address,
      purchase_price_cents: loan.purchase_price_cents,
      appraised_value_cents: loan.appraised_value_cents,
      lock_expires_at: loan.lock_expires_at,
      le_sent_at: loan.le_sent_at,
      cd_sent_at: loan.cd_sent_at,
      borrowers,
      fees,
      pricing,
      branch,
      lo: loan.lo,
    };
  }

  // Generate the right PDF for the package type. CD and closing_docs
  // throw "not yet supported" — those generators land with the closing
  // workflow turn.
  async function generatePackagePdf(kind, data) {
    if (typeof window.OFDisclosure === 'undefined') {
      throw new Error('OFDisclosure not available — disclosure-pdf.js failed to load');
    }
    const D = window.OFDisclosure;
    if (kind === 'initial_disclosures') {
      if (typeof D.generateInitialDisclosurePackage !== 'function') {
        throw new Error('OFDisclosure.generateInitialDisclosurePackage missing');
      }
      return await D.generateInitialDisclosurePackage(data);
    }
    if (kind === 'revised_le') {
      if (typeof D.generateLoanEstimate !== 'function') {
        throw new Error('OFDisclosure.generateLoanEstimate missing');
      }
      return await D.generateLoanEstimate(data);
    }
    if (kind === 'cd' || kind === 'closing_docs') {
      throw new Error(
        kind === 'cd'
          ? 'CD generation is not yet implemented. Use initial_disclosures or revised_le for now.'
          : 'Closing-docs generation is not yet implemented.'
      );
    }
    throw new Error('Unknown package type: ' + kind);
  }

  // Upload the generated PDF to the loan-documents bucket. Path matches
  // the convention OF_uploadFile uses, so storage RLS and the documents.
  // html signed-URL helper both work transparently.
  async function uploadDisclosurePdf(pdfBytes, data, kind) {
    const client = supa();
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Not signed in');

    const { data: profile } = await client.from('profiles')
      .select('branch_id').eq('id', session.user.id).maybeSingle();
    if (!profile?.branch_id) throw new Error('Could not resolve branch');

    // Find the loan_id from the data so the path matches the loan folder.
    // We don't have it directly on the disclosure-data shape, so look it
    // up by loan_number. This is a tradeoff vs threading loan_id through
    // — keeping it self-contained is cleaner.
    const { data: loan } = await client.from('loans')
      .select('id').eq('loan_number', data.loan_number)
      .eq('branch_id', profile.branch_id).maybeSingle();
    if (!loan?.id) throw new Error('Could not resolve loan_id from loan_number');

    // Filename: e.g.  initial_disclosures-2026-05-09T15-30-22Z.pdf
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${kind}-${ts}.pdf`;
    const path = `${profile.branch_id}/${loan.id}/${fileName}`;

    const { error: upErr } = await client.storage
      .from('loan-documents')
      .upload(path, pdfBytes, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (upErr) {
      throw new Error('Source PDF upload failed: ' + upErr.message);
    }
    return path;
  }

  // Insert a documents row for the source PDF so it's visible in the
  // Documents tab. Use status='uploaded' (skip the malware scanner — we
  // generated the PDF locally, no scan needed).
  async function registerDisclosureDocument(path, sizeBytes, data, kind) {
    const client = supa();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return;

    const { data: profile } = await client.from('profiles')
      .select('branch_id').eq('id', session.user.id).maybeSingle();
    if (!profile?.branch_id) return;

    const { data: loan } = await client.from('loans')
      .select('id').eq('loan_number', data.loan_number)
      .eq('branch_id', profile.branch_id).maybeSingle();
    if (!loan?.id) return;

    // doc_type values picked to match what the documents library and
    // future filters expect. 'le' is more specific than 'other' for
    // initial disclosures even though the package is multi-doc.
    const DOC_TYPE_BY_KIND = {
      initial_disclosures: 'le',
      revised_le: 'le',
      cd: 'closing_disclosure',
      closing_docs: 'closing_docs',
    };

    // file_name becomes what the lender sees in the docs list. Friendly
    // human label, not the raw filename used in storage.
    const FRIENDLY = {
      initial_disclosures: 'Initial Disclosures',
      revised_le: 'Revised Loan Estimate',
      cd: 'Closing Disclosure',
      closing_docs: 'Closing Documents',
    };
    const friendly = FRIENDLY[kind] || kind;
    const fileName = `${friendly} — ${data.loan_number} — ${new Date().toLocaleDateString('en-US')}.pdf`;

    const { error } = await client.from('documents').insert({
      branch_id: profile.branch_id,
      loan_id: loan.id,
      uploaded_by: session.user.id,
      file_name: fileName,
      file_url: path,
      file_size_bytes: sizeBytes,
      mime_type: 'application/pdf',
      doc_type: DOC_TYPE_BY_KIND[kind] || 'other',
      status: 'uploaded',
      uploaded_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  // Lazy-load /js/disclosure-pdf.js if OFDisclosure isn't already on
  // window. Keeps loan.html simple — no extra <script> tag required;
  // disclosure-pdf.js only loads when the user actually clicks "Send
  // for eSign" (and once loaded, it's cached for the session).
  let _disclosureModulePromise = null;
  function ensureDisclosureModuleLoaded() {
    if (typeof window.OFDisclosure !== 'undefined') return Promise.resolve();
    if (_disclosureModulePromise) return _disclosureModulePromise;
    _disclosureModulePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/disclosure-pdf.js';
      s.async = true;
      s.onload = () => {
        if (typeof window.OFDisclosure === 'undefined') {
          reject(new Error('disclosure-pdf.js loaded but OFDisclosure global missing'));
        } else {
          resolve();
        }
      };
      s.onerror = () => reject(new Error('Failed to load /js/disclosure-pdf.js — make sure it is deployed alongside of-hooks.js'));
      document.head.appendChild(s);
    });
    return _disclosureModulePromise;
  }

})();
