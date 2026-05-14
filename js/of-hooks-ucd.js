// =============================================================================
// of-hooks-ucd.js
// -----------------------------------------------------------------------------
// OriginFlow LOS · Round 10 · Patch 10.2
//
// PURPOSE
//   Client-side invoker for the submit-ucd edge function. Exposes
//   window.OF_submitUcd on the same window.OF_<hook> pattern established
//   by of-hooks-mismo.js (9.14) and of-hooks-ucdp.js (10.1).
//
//   UCD differs from UCDP in three places that the hook surfaces:
//     - three GSEs instead of two (Fannie / Freddie / Ginnie)
//     - optional `investor` filter to submit to a subset
//     - aggregate status across all included GSEs (worst wins)
//
// CONTRACT
//   await window.OF_submitUcd({
//     loan_id: string,                    required
//     force_mock?: boolean,                default false
//     seller_servicer_number?: string      optional override
//     lender_loan_no?: string              optional override of loan number
//     investor?: 'fnma'|'fhlmc'|'gnma'|'all'   default 'all'
//   })
//   → resolves to { ok: true, ...edge_response_body }
//     rejects with Error whose .code is one of:
//       'not_signed_in', 'edge_unreachable', 'http_<status>',
//       'malformed_response', or any error code returned by the edge function
//
// USAGE EXPECTATIONS
//   - window.OF_supabase must be initialized (the of-bootstrap shim does this)
//   - window.OF_toast is optional; absent it we fall back to console
// =============================================================================

(function () {
  'use strict';

  function resolveFunctionUrl() {
    const base =
      (window.OF_supabase && window.OF_supabase.functionsUrl) ||
      window.OF_FUNCTIONS_URL ||
      (window.OF_SUPABASE_URL ? window.OF_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1' : null);
    if (!base) return null;
    return base.replace(/\/$/, '') + '/submit-ucd';
  }

  function toast(level, msg, detail) {
    if (window.OF_toast && typeof window.OF_toast === 'function') {
      try {
        window.OF_toast({ level: level, message: msg, detail: detail });
        return;
      } catch (e) { /* fall through */ }
    }
    if (level === 'error') console.error('[OF_submitUcd]', msg, detail || '');
    else if (level === 'warn') console.warn('[OF_submitUcd]', msg, detail || '');
    else console.log('[OF_submitUcd]', msg, detail || '');
  }

  async function getAccessToken() {
    if (!window.OF_supabase || !window.OF_supabase.auth) {
      const e = new Error('supabase client not initialized');
      e.code = 'supabase_client_missing';
      throw e;
    }
    const { data, error } = await window.OF_supabase.auth.getSession();
    if (error) {
      const e = new Error(error.message);
      e.code = 'auth_session_error';
      throw e;
    }
    const token = data && data.session && data.session.access_token;
    if (!token) {
      const e = new Error('not signed in');
      e.code = 'not_signed_in';
      throw e;
    }
    return token;
  }

  // ---------------------------------------------------------------------------
  // Investor label helper — used only for toast text.
  // ---------------------------------------------------------------------------
  function investorLabel(inv) {
    switch (inv) {
      case 'fnma': return 'Fannie Mae';
      case 'fhlmc': return 'Freddie Mac';
      case 'gnma': return 'Ginnie Mae';
      case 'all':
      default: return 'all GSEs';
    }
  }

  async function OF_submitUcd(args) {
    args = args || {};
    if (!args.loan_id || typeof args.loan_id !== 'string') {
      const e = new Error('loan_id is required');
      e.code = 'loan_id_required';
      throw e;
    }

    // Normalize investor filter on the client side too so toast text and
    // edge function agree. Anything weird → 'all'.
    let investor = (args.investor || 'all').toString().toLowerCase();
    if (investor !== 'fnma' && investor !== 'fhlmc' && investor !== 'gnma' && investor !== 'all') {
      investor = 'all';
    }

    const url = resolveFunctionUrl();
    if (!url) {
      const e = new Error('edge function URL could not be resolved');
      e.code = 'edge_url_missing';
      throw e;
    }

    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      toast('error', 'UCD submission requires sign-in', e.code);
      throw e;
    }

    const body = {
      loan_id: args.loan_id,
      force_mock: args.force_mock === true,
      investor: investor,
    };
    if (args.seller_servicer_number) body.seller_servicer_number = args.seller_servicer_number;
    if (args.lender_loan_no) body.lender_loan_no = args.lender_loan_no;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      toast('error', 'Could not reach UCD submission endpoint', netErr.message);
      const e = new Error('edge function unreachable: ' + netErr.message);
      e.code = 'edge_unreachable';
      throw e;
    }

    let parsed;
    try {
      parsed = await res.json();
    } catch (parseErr) {
      toast('error', 'Malformed response from UCD submission endpoint');
      const e = new Error('malformed response');
      e.code = 'malformed_response';
      e.status = res.status;
      throw e;
    }

    if (!res.ok || !parsed || parsed.ok !== true) {
      const code = (parsed && parsed.error) || ('http_' + res.status);
      const detail = (parsed && parsed.detail) || res.statusText;
      toast('error', 'UCD submission failed: ' + code, detail);
      const e = new Error(code + (detail ? ': ' + detail : ''));
      e.code = code;
      e.detail = detail;
      e.status = res.status;
      throw e;
    }

    // ---- Non-fatal warnings -------------------------------------------------
    if (parsed.mock) {
      toast('warn', 'UCD returned mock CD findings (real adapter not yet implemented)',
        'submission ' + parsed.submission_id);
    }
    if (parsed.deliveries_upsert_skipped && parsed.deliveries_upsert_skipped.length) {
      toast('warn',
        'UCD saved, but loan_deliveries schema missing columns: ' +
          parsed.deliveries_upsert_skipped.join(', '),
        'run the 9.13 migration to add the ucd_* columns');
    }
    if (parsed.audit_recorded === false) {
      toast('warn', 'UCD succeeded but audit event failed to write', 'check loan_audit_events RLS');
    }

    // ---- Status surface ----------------------------------------------------
    if (!parsed.mock && !(parsed.deliveries_upsert_skipped && parsed.deliveries_upsert_skipped.length)) {
      const label = investorLabel(investor);
      const counts = (parsed.finding_count || 0) + ' findings, ' + (parsed.warning_count || 0) + ' warnings';
      const statusMsg =
        parsed.status === 'successful' ? 'UCD submission to ' + label + ' successful' :
        parsed.status === 'successful_with_overrides' ? 'UCD to ' + label + ' successful with overrides' :
        'UCD to ' + label + ' unsuccessful — review findings';
      toast(parsed.status === 'unsuccessful' ? 'error' : 'info', statusMsg,
        parsed.submission_id + ' · ' + counts);
    }

    return parsed;
  }

  if (window.OF_submitUcd) {
    console.warn('[of-hooks-ucd] window.OF_submitUcd already defined; not overwriting');
  } else {
    window.OF_submitUcd = OF_submitUcd;
  }
})();
