// =============================================================================
// of-hooks-ucdp.js
// -----------------------------------------------------------------------------
// OriginFlow LOS · Round 10 · Patch 10.1
//
// PURPOSE
//   Client-side invoker for the submit-ucdp edge function. Exposes a single
//   global, window.OF_submitUcdp, on the namespace pattern established by
//   of-hooks-mismo.js in 9.14 and the broader window.OF_<hook> convention
//   used throughout OriginFlow's frontend integration points.
//
// CONTRACT
//   await window.OF_submitUcdp({
//     loan_id: string,             required
//     force_mock?: boolean,         default false; pass true for deterministic mock
//     seller_servicer_number?: string  optional override
//     lender_loan_no?: string       optional override of the loan number
//   })
//   → resolves to { ok: true, ...edge_response_body }
//     rejects with Error whose .code is one of:
//       'not_signed_in', 'edge_unreachable', 'http_<status>', 'malformed_response',
//       or any error code returned by the edge function
//
// USAGE EXPECTATIONS
//   - Page must have loaded a supabase-js client at window.OF_supabase (the
//     of-bootstrap shim sets this up). If absent, the hook throws
//     'supabase_client_missing' immediately so the caller sees a real error
//     instead of a generic auth failure.
//   - Toasts are emitted through window.OF_toast if present; otherwise we
//     fall back to console.warn/error so the hook is safe to call from
//     pages that haven't loaded the toast component.
//
// AUDIT TRAIL
//   The edge function emits its own loan_audit_events row for ucdp_submit.
//   This hook does not need to write an audit event — only relay the
//   result and surface warnings (e.g. mock fallback, skipped columns) to
//   the operator.
//
// ARCHITECTURAL NOTE
//   This file deliberately has no build step. It's a single ES module that
//   attaches to window on load. Pages include it with a plain <script>
//   tag, matching the script-tag inventory pattern still being audited
//   across loans-new.html / documents.html / loan.html (followup carried
//   forward from Round 9).
// =============================================================================

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Endpoint resolution.
  //
  // We resolve the edge function URL from window.OF_supabase.functions.url
  // when available (supabase-js exposes this), or compute it from
  // window.OF_SUPABASE_URL set on the page (the pattern used by older pages
  // that don't have a client instance loaded yet). The function name is
  // appended.
  // ---------------------------------------------------------------------------
  function resolveFunctionUrl() {
    const base =
      (window.OF_supabase && window.OF_supabase.functionsUrl) ||
      window.OF_FUNCTIONS_URL ||
      (window.OF_SUPABASE_URL ? window.OF_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1' : null);
    if (!base) return null;
    return base.replace(/\/$/, '') + '/submit-ucdp';
  }

  // ---------------------------------------------------------------------------
  // Toast helper — graceful no-op when window.OF_toast is missing.
  // ---------------------------------------------------------------------------
  function toast(level, msg, detail) {
    if (window.OF_toast && typeof window.OF_toast === 'function') {
      try {
        window.OF_toast({ level: level, message: msg, detail: detail });
        return;
      } catch (e) {
        // fall through
      }
    }
    if (level === 'error') console.error('[OF_submitUcdp]', msg, detail || '');
    else if (level === 'warn') console.warn('[OF_submitUcdp]', msg, detail || '');
    else console.log('[OF_submitUcdp]', msg, detail || '');
  }

  // ---------------------------------------------------------------------------
  // Auth token resolution.
  //
  // We pull the access token off the supabase client's current session. If
  // the client is missing entirely we throw 'supabase_client_missing'; if a
  // session is missing we throw 'not_signed_in'. Either way the caller
  // gets a typed error code on .code.
  // ---------------------------------------------------------------------------
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
  // The hook itself.
  //
  // Resolves URL + token, POSTs, surfaces errors with typed codes, emits
  // toasts for non-fatal warnings (mock fallback, skipped schema columns).
  // Returns the parsed edge-function body on success.
  // ---------------------------------------------------------------------------
  async function OF_submitUcdp(args) {
    args = args || {};
    if (!args.loan_id || typeof args.loan_id !== 'string') {
      const e = new Error('loan_id is required');
      e.code = 'loan_id_required';
      throw e;
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
      toast('error', 'UCDP submission requires sign-in', e.code);
      throw e;
    }

    const body = {
      loan_id: args.loan_id,
      force_mock: args.force_mock === true,
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
      toast('error', 'Could not reach UCDP submission endpoint', netErr.message);
      const e = new Error('edge function unreachable: ' + netErr.message);
      e.code = 'edge_unreachable';
      throw e;
    }

    let parsed;
    try {
      parsed = await res.json();
    } catch (parseErr) {
      toast('error', 'Malformed response from UCDP submission endpoint');
      const e = new Error('malformed response');
      e.code = 'malformed_response';
      e.status = res.status;
      throw e;
    }

    if (!res.ok || !parsed || parsed.ok !== true) {
      const code = (parsed && parsed.error) || ('http_' + res.status);
      const detail = (parsed && parsed.detail) || res.statusText;
      toast('error', 'UCDP submission failed: ' + code, detail);
      const e = new Error(code + (detail ? ': ' + detail : ''));
      e.code = code;
      e.detail = detail;
      e.status = res.status;
      throw e;
    }

    // ---- Success surface ---------------------------------------------------
    // Two non-fatal conditions we want to flag in the UI:
    //   - mock=true → vendor adapter not in play, operator should know
    //   - deliveries_upsert_skipped non-empty → schema drift, soft warning
    if (parsed.mock) {
      toast('warn', 'UCDP returned mock SSR (real adapter not yet implemented)',
        'submission ' + parsed.submission_id);
    }
    if (parsed.deliveries_upsert_skipped && parsed.deliveries_upsert_skipped.length) {
      toast('warn',
        'UCDP saved, but loan_deliveries schema missing columns: ' +
          parsed.deliveries_upsert_skipped.join(', '),
        'run the 9.13 migration to add the ucdp_* columns');
    }
    if (parsed.audit_recorded === false) {
      toast('warn', 'UCDP succeeded but audit event failed to write', 'check loan_audit_events RLS');
    }
    if (!parsed.mock && !parsed.deliveries_upsert_skipped?.length) {
      const statusMsg =
        parsed.status === 'successful' ? 'UCDP submission successful' :
        parsed.status === 'successful_with_overrides' ? 'UCDP successful with overrides' :
        'UCDP submission unsuccessful — review findings';
      toast(parsed.status === 'unsuccessful' ? 'error' : 'info', statusMsg,
        parsed.submission_id + ' · ' + (parsed.finding_count || 0) + ' findings');
    }

    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Attach to window. We don't overwrite an existing OF_submitUcdp because
  // a page-local override could be intentional (testing, demos). We log a
  // warning instead so the conflict is visible.
  // ---------------------------------------------------------------------------
  if (window.OF_submitUcdp) {
    console.warn('[of-hooks-ucdp] window.OF_submitUcdp already defined; not overwriting');
  } else {
    window.OF_submitUcdp = OF_submitUcdp;
  }
})();
