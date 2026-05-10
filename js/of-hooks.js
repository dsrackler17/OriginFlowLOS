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
// ─── ROUND 4 hooks (eSign + AUS) ───────────────────────────────────────────
//   • window.OF_sendForESign        — generates LE/CD PDF, uploads, dispatches
//                                     to Dropbox Sign via dispatch-esign edge fn
//   • window.OF_runAus              — generates MISMO 3.4 XML, dispatches to
//                                     run-aus edge function, returns
//                                     recommendation + outcome
//
// Pages that use eSign also need /js/disclosure-pdf.js, AUS pages need
// /js/mismo-generator.js — both lazy-loaded by this file when first
// invoked. No HTML script-tag changes required.
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
  window.OF_uploadFile = async function (file, onProgress) {
    const ALLOWED = [
      'application/pdf',
      'image/png', 'image/jpeg', 'image/jpg',
    ];
    if (!ALLOWED.includes(file.type)) {
      throw new Error(`File type "${file.type || 'unknown'}" not allowed. Use PDF, PNG, or JPEG.`);
    }

    const path = await buildStoragePath(file, getLoanIdFromContext());

    if (typeof onProgress === 'function') onProgress(10);

    const { error: upErr } = await supa()
      .storage.from('loan-documents')
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });
    if (upErr) {
      if (upErr.message?.includes('Bucket not found')) {
        throw new Error('Storage bucket "loan-documents" not created yet. Run sql/02_storage_bucket.sql.');
      }
      throw new Error(`Upload failed: ${upErr.message}`);
    }

    if (typeof onProgress === 'function') onProgress(85);

    const file_url = path;

    setTimeout(async () => {
      try {
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

  function getLoanIdFromContext() {
    const sel = document.querySelector('#upload-loan');
    return sel && sel.value ? sel.value : null;
  }

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
      let msg = error.message || 'Extraction failed';
      try {
        if (error.context) {
          const body = await error.context.json();
          if (body?.error) msg = body.error;
        }
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return data;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. APPLY EXTRACTION ACTION — write-back to loan/borrower/condition
  // ═══════════════════════════════════════════════════════════════════════════
  window.OF_applyExtractionAction = async function (documentId, action) {
    try {
      const { data, error } = await supa().functions.invoke('apply-extraction-action', {
        body: { document_id: documentId, action_key: action.key, action },
      });
      if (error) throw error;
      return data;
    } catch (err) {
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
  // ═══════════════════════════════════════════════════════════════════════════
  window.OF_getSignedUrl = async function (path) {
    if (!path) return null;
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
  // eSign". Generates the disclosure PDF, uploads to loan-documents,
  // registers a documents row, invokes dispatch-esign edge function.
  //
  // Input:   { loanId, package_type: 'initial_disclosures' | 'revised_le'
  //                                  | 'cd' | 'closing_docs' }
  // Returns: { envelope_id, vendor_envelope_id, signers, test_mode }
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

    await ensureDisclosureModuleLoaded();

    const data = await fetchDisclosureData(loanId);

    const pdfBytes = await generatePackagePdf(kind, data);
    if (!pdfBytes || pdfBytes.length === 0) {
      throw new Error('PDF generation returned empty bytes');
    }

    const sourcePath = await uploadDisclosurePdf(pdfBytes, data, kind);

    try {
      await registerDisclosureDocument(sourcePath, pdfBytes.length, data, kind);
    } catch (err) {
      console.warn('OF_sendForESign: documents row insert failed (non-fatal):', err);
    }

    const { data: dispatchResult, error: dispatchErr } = await supa()
      .functions.invoke('dispatch-esign', {
        body: { loan_id: loanId, kind, source_pdf_path: sourcePath },
      });

    if (dispatchErr) {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. RUN AUS — Round 4
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Called from loan.html when the LO clicks "Run AUS" on the AUS Findings
  // tab. Generates MISMO 3.4 XML client-side via OFMismo, validates the
  // loan data shape, builds an audit snapshot, and invokes the run-aus
  // edge function which persists aus_runs + aus_findings, auto-promotes
  // required findings to conditions, and returns the recommendation.
  //
  // Input:
  //   { loanId, engine?: 'du' | 'lp' | 'gus' (default 'du'),
  //     force_mock?: boolean }
  //
  // Returns:
  //   {
  //     run_id, engine, recommendation, outcome,
  //     findings_summary, findings_count, required_findings_count,
  //     promoted_conditions_count, is_mock, duration_ms,
  //     warnings: string[]               // browser-side validation warnings
  //   }
  //
  // The caller can use `warnings` to surface "the AUS will likely flag
  // these issues" before showing the user the recommendation. We don't
  // block on warnings — let the AUS see them, since that's what AUS is
  // for. validateLoanDataShape only catches structural data-quality
  // issues (missing SSN, missing address) that any AUS will reject.
  // ═══════════════════════════════════════════════════════════════════════════

  const VALID_ENGINES = ['du', 'lp', 'gus'];

  window.OF_runAus = async function (opts) {
    const opts_ = opts || {};
    const loanId = opts_.loanId;
    const engine = opts_.engine || 'du';
    const forceMock = opts_.force_mock === true;

    if (!loanId) throw new Error('loanId is required');
    if (!VALID_ENGINES.includes(engine)) {
      throw new Error('engine must be one of: ' + VALID_ENGINES.join(', '));
    }

    // 1. Lazy-load the MISMO generator. Cached across calls.
    await ensureMismoModuleLoaded();

    // 2. Pull the loan data. Same shape as eSign uses, plus DTI/LTV which
    //    the mock AUS engine reads to decide approve/refer/ineligible.
    const data = await fetchDisclosureData(loanId);

    // 3. Validate the data shape. These are warnings the user may want
    //    to see before submission ("DU will reject without full SSN") —
    //    we surface them but don't block. The mock engine in the edge
    //    function reads borrower_ssn_status from the snapshot to decide
    //    whether to hard-fail; real AUS would do its own check.
    const M = window.OFMismo;
    const warnings = M.validateLoanDataShape(data) || [];

    // 4. Build the request snapshot. Captures the inputs the AUS made
    //    its recommendation against, so a later auditor can answer "what
    //    was the DTI when DU approved this on May 9?". The snapshot also
    //    drives the mock engine — borrower_ssn_status tells it whether
    //    to fail.
    const snapshot = buildAusSnapshot(data, warnings);

    // 5. Generate MISMO XML.
    let mismoXml;
    try {
      mismoXml = M.generateMISMO34(data);
    } catch (err) {
      throw new Error('MISMO generation failed: ' + (err.message || err));
    }
    if (!mismoXml || mismoXml.length < 200) {
      throw new Error('MISMO generation produced an empty or trivially-small payload');
    }

    // 6. Invoke the edge function.
    const { data: result, error: runErr } = await supa()
      .functions.invoke('run-aus', {
        body: {
          loan_id: loanId,
          engine,
          mismo_xml: mismoXml,
          request_snapshot: snapshot,
          force_mock: forceMock,
        },
      });

    if (runErr) {
      let msg = runErr.message || 'run-aus failed';
      try {
        if (runErr.context) {
          const body = await runErr.context.json();
          if (body?.error) msg = body.error;
        }
      } catch (_) { /* ignore */ }
      throw new Error('AUS run failed: ' + msg);
    }

    if (!result || !result.run_id) {
      throw new Error('run-aus returned no run_id — check the function logs');
    }

    // Browser-side augmentation: attach the validation warnings so the
    // caller can show them alongside the recommendation. The edge function
    // intentionally doesn't run validation — that's the browser's job.
    return Object.assign({}, result, { warnings });
  };

  // Build the audit snapshot. This goes into aus_runs.request_snapshot
  // verbatim. Keep it small — the request_xml is the primary artifact
  // and the snapshot is for "let me skim what was sent" debugging.
  function buildAusSnapshot(data, warnings) {
    // borrower_ssn_status: the mock AUS engine reads this list. Each
    // entry is 'present' (full 9-digit), 'last4_only', or 'missing'.
    var ssnStatus = (data.borrowers || []).map(function (b) {
      if (!b) return 'missing';
      if (b.ssn) {
        var d = String(b.ssn).replace(/\D/g, '');
        if (d.length === 9) return 'present';
        if (d.length === 4) return 'last4_only';
      }
      if (b.ssn_last4) return 'last4_only';
      return 'missing';
    });

    return {
      generated_at: new Date().toISOString(),
      generator: 'OFMismo/1.0',
      loan_number: data.loan_number,
      borrower_count: (data.borrowers || []).length,
      borrower_ssn_status: ssnStatus,
      loan_amount_cents: data.loan_amount_cents,
      rate_bps: data.rate_bps,
      term_months: data.term_months,
      program: data.program,
      purpose: data.purpose,
      occupancy: data.occupancy,
      property_type: data.property_type,
      property_state: data.property_address && data.property_address.state,
      ltv_pct: data.ltv_pct != null ? Number(data.ltv_pct) : null,
      cltv_pct: data.cltv_pct != null ? Number(data.cltv_pct) : null,
      dti_back_pct: data.dti_back_pct != null ? Number(data.dti_back_pct) : null,
      validation_warning_count: warnings.length,
      // Cap warnings list so a flood of warnings doesn't blow up the
      // jsonb column. The full list goes back to the UI; the snapshot
      // gets a head sample.
      validation_warnings_sample: warnings.slice(0, 20),
    };
  }

  // ─── Shared data fetcher (used by both eSign and AUS) ─────────────────────
  //
  // Pull all the data OFDisclosure / OFMismo need. Mirrors the loan.html
  // bootstrap query but adds fees, pricing, and branch in separate
  // parallel queries since they're not on FK paths from `loans`.
  //
  // CHANGE since Round 4-1: dti_back_pct, ltv_pct, cltv_pct, and
  // application_received_at (created_at fallback) are surfaced on the
  // returned shape so OFMismo and the AUS mock engine can use them.
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
        created_at,
        lo_id, lo:profiles!lo_id ( id, full_name, email, nmls_id ),
        borrowers:loan_borrowers (
          position,
          borrower:borrowers!borrower_id (
            id, first_name, last_name, middle_name, suffix,
            email, phone, dob, ssn_last4
          )
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

    const [loanRes, feesRes, pricingRes] = await Promise.allSettled([loanQ, feesQ, pricingQ]);

    if (loanRes.status !== 'fulfilled' || loanRes.value.error || !loanRes.value.data) {
      const err = loanRes.status === 'fulfilled' ? loanRes.value.error : loanRes.reason;
      throw new Error('Loan fetch failed: ' + (err?.message || 'not found'));
    }
    const loan = loanRes.value.data;

    let fees = [];
    if (feesRes.status === 'fulfilled' && !feesRes.value.error) {
      fees = feesRes.value.data || [];
    } else if (feesRes.status === 'fulfilled' && feesRes.value.error) {
      console.warn('fees fetch failed (using empty array):', feesRes.value.error.message);
    }

    let pricing = null;
    if (pricingRes.status === 'fulfilled' && !pricingRes.value.error) {
      pricing = pricingRes.value.data;
    }

    let branch = null;
    {
      const { data: br, error: brErr } = await client.from('branches')
        .select('id, name, nmls_id, license_number, address')
        .eq('id', loan.branch_id)
        .maybeSingle();
      if (brErr) console.warn('branch fetch failed (using minimal):', brErr.message);
      branch = br || { id: loan.branch_id, name: 'Your Branch' };
    }

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
      // Round 4-3: surface the underwriting metrics the mock AUS reads
      ltv_pct: loan.ltv_pct,
      cltv_pct: loan.cltv_pct,
      dti_back_pct: loan.dti_back_pct,
      // For MISMO ApplicationReceivedDate
      application_received_at: loan.created_at,
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

  // ─── eSign-specific helpers ───────────────────────────────────────────────

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

  async function uploadDisclosurePdf(pdfBytes, data, kind) {
    const client = supa();
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Not signed in');

    const { data: profile } = await client.from('profiles')
      .select('branch_id').eq('id', session.user.id).maybeSingle();
    if (!profile?.branch_id) throw new Error('Could not resolve branch');

    const { data: loan } = await client.from('loans')
      .select('id').eq('loan_number', data.loan_number)
      .eq('branch_id', profile.branch_id).maybeSingle();
    if (!loan?.id) throw new Error('Could not resolve loan_id from loan_number');

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

    const DOC_TYPE_BY_KIND = {
      initial_disclosures: 'le',
      revised_le: 'le',
      cd: 'closing_disclosure',
      closing_docs: 'closing_docs',
    };

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

  // ─── Lazy-loaders ─────────────────────────────────────────────────────────
  // Both modules are pulled in only when first invoked, then cached for
  // the session. No HTML script-tag changes required when adding eSign or
  // AUS to a page — just include /js/of-hooks.js and the relevant globals
  // appear on demand.

  let _disclosureModulePromise = null;
  function ensureDisclosureModuleLoaded() {
    if (typeof window.OFDisclosure !== 'undefined') return Promise.resolve();
    if (_disclosureModulePromise) return _disclosureModulePromise;
    _disclosureModulePromise = loadScript(
      '/js/disclosure-pdf.js',
      'OFDisclosure',
      'disclosure-pdf.js loaded but OFDisclosure global missing',
      'Failed to load /js/disclosure-pdf.js — make sure it is deployed alongside of-hooks.js'
    );
    return _disclosureModulePromise;
  }

  let _mismoModulePromise = null;
  function ensureMismoModuleLoaded() {
    if (typeof window.OFMismo !== 'undefined') return Promise.resolve();
    if (_mismoModulePromise) return _mismoModulePromise;
    _mismoModulePromise = loadScript(
      '/js/mismo-generator.js',
      'OFMismo',
      'mismo-generator.js loaded but OFMismo global missing',
      'Failed to load /js/mismo-generator.js — make sure it is deployed alongside of-hooks.js'
    );
    return _mismoModulePromise;
  }

  // Generic script loader — appends a <script> tag and resolves when the
  // expected global appears on window. Handles network errors and the
  // case where the script loads but doesn't expose its global (which
  // means the file is corrupted or the wrong file is at that URL).
  function loadScript(src, globalName, missingGlobalErr, networkErr) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (typeof window[globalName] === 'undefined') {
          reject(new Error(missingGlobalErr));
        } else {
          resolve();
        }
      };
      s.onerror = function () { reject(new Error(networkErr)); };
      document.head.appendChild(s);
    });
  }

})();
