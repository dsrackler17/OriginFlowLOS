// =============================================================================
// of-hooks-crm-push.js
// -----------------------------------------------------------------------------
// OriginFlow LOS · Round 10 · Patch 10.5
//
// PURPOSE
//   Client-side invoker for the push-to-crm edge function. Exposes
//   window.OF_pushToCrm on the same window.OF_<hook> pattern established
//   by of-hooks-mismo.js (9.14), of-hooks-ucdp.js (10.1), and
//   of-hooks-ucd.js (10.2).
//
//   Unlike Track A's submission hooks where a successful response means
//   "the operation succeeded", a successful response from push-to-crm
//   may still represent a failed sync (status='failed') or a scheduled
//   retry (status='retrying'). The hook surfaces all three outcomes
//   distinctly through the toast bridge so the LO surface sees the
//   right state without parsing the response.
//
// CONTRACT
//   await window.OF_pushToCrm({
//     loan_id:          string,           required
//     connection_id?:   string,            optional; default = auto-resolve
//                                          via LO precedence then branch-shared
//     force_mock?:      boolean,           default false
//     trigger_source?:  'manual' | 'loan_state_change' | 'webhook' | 'scheduled',
//                                          default 'manual'
//     retry_of_event_id?: string,          optional; chain a retry to a prior
//                                          crm_sync_events row
//   })
//   → resolves to { ok: true, event_id, status, attempt_no, vendor, field_count,
//                   vendor_record_id, retry_after, mock, error_code, error_message }
//     rejects with Error whose .code is one of:
//       'not_signed_in', 'edge_unreachable', 'http_<status>',
//       'malformed_response', or any error code returned by the edge fn
//
// SUCCESS VS DISPATCH-FAILURE
//   The edge function returns ok:true even when the CRM push itself failed,
//   as long as we got far enough to write a crm_sync_events row. This is
//   intentional — the panel needs the event_id to render the failure
//   detail. The hook differentiates the toast level by parsed.status:
//     status === 'success'       → info toast
//     status === 'partial'       → warn toast (some fields failed)
//     status === 'retrying'      → warn toast (will be retried)
//     status === 'failed'        → error toast (terminal, won't retry)
//
//   Only setup-time failures (auth, missing loan, no connection) come back
//   as ok:false and the hook throws.
// =============================================================================

(function () {
  'use strict';

  function resolveFunctionUrl() {
    const base =
      (window.OF_supabase && window.OF_supabase.functionsUrl) ||
      window.OF_FUNCTIONS_URL ||
      (window.OF_SUPABASE_URL ? window.OF_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1' : null);
    if (!base) return null;
    return base.replace(/\/$/, '') + '/push-to-crm';
  }

  function toast(level, msg, detail) {
    if (window.OF_toast && typeof window.OF_toast === 'function') {
      try {
        window.OF_toast({ level: level, message: msg, detail: detail });
        return;
      } catch (e) { /* fall through */ }
    }
    if (level === 'error') console.error('[OF_pushToCrm]', msg, detail || '');
    else if (level === 'warn') console.warn('[OF_pushToCrm]', msg, detail || '');
    else console.log('[OF_pushToCrm]', msg, detail || '');
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
  // Vendor label for toast text.
  // ---------------------------------------------------------------------------
  function vendorLabel(vendor) {
    switch (vendor) {
      case 'surefire':  return 'Surefire';
      case 'topofmind': return 'Top of Mind';
      case 'bntouch':   return 'BNTouch';
      case 'velocity':  return 'Velocity';
      case 'hubspot':   return 'HubSpot';
      default:          return vendor || 'CRM';
    }
  }

  // ---------------------------------------------------------------------------
  // The hook itself.
  // ---------------------------------------------------------------------------
  async function OF_pushToCrm(args) {
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
      toast('error', 'CRM push requires sign-in', e.code);
      throw e;
    }

    const body = {
      loan_id: args.loan_id,
      force_mock: args.force_mock === true,
      trigger_source: args.trigger_source || 'manual',
    };
    if (args.connection_id)     body.connection_id = args.connection_id;
    if (args.retry_of_event_id) body.retry_of_event_id = args.retry_of_event_id;

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
      toast('error', 'Could not reach CRM push endpoint', netErr.message);
      const e = new Error('edge function unreachable: ' + netErr.message);
      e.code = 'edge_unreachable';
      throw e;
    }

    let parsed;
    try {
      parsed = await res.json();
    } catch (parseErr) {
      toast('error', 'Malformed response from CRM push endpoint');
      const e = new Error('malformed response');
      e.code = 'malformed_response';
      e.status = res.status;
      throw e;
    }

    if (!res.ok || !parsed || parsed.ok !== true) {
      const code = (parsed && parsed.error) || ('http_' + res.status);
      const detail = (parsed && parsed.detail) || res.statusText;
      toast('error', 'CRM push setup failed: ' + code, detail);
      const e = new Error(code + (detail ? ': ' + detail : ''));
      e.code = code;
      e.detail = detail;
      e.status = res.status;
      throw e;
    }

    // ---- Status-driven toast surface ---------------------------------------
    const vlabel = vendorLabel(parsed.vendor);
    const counts = parsed.field_count || {};
    const countsLine = (counts.mapped || 0) + ' mapped · ' +
                       (counts.transformed || 0) + ' transformed · ' +
                       (counts.skipped || 0) + ' skipped · ' +
                       (counts.failed || 0) + ' failed';

    if (parsed.mock) {
      toast('warn', 'Pushed to ' + vlabel + ' (mock — real adapter pending)',
        'attempt ' + parsed.attempt_no + ' · ' + countsLine);
    }

    if (parsed.status === 'success') {
      toast('info', 'CRM push successful to ' + vlabel,
        (parsed.vendor_record_id ? 'record ' + parsed.vendor_record_id + ' · ' : '') + countsLine);
    } else if (parsed.status === 'partial') {
      toast('warn', 'CRM push partial to ' + vlabel,
        (parsed.vendor_record_id ? 'record ' + parsed.vendor_record_id + ' · ' : '') + countsLine);
    } else if (parsed.status === 'retrying') {
      const retryWhen = parsed.retry_after ? new Date(parsed.retry_after).toLocaleTimeString() : 'soon';
      toast('warn', 'CRM push will retry at ' + retryWhen,
        (parsed.error_code || 'retryable') + ' · attempt ' + parsed.attempt_no + '/5');
    } else if (parsed.status === 'failed') {
      toast('error', 'CRM push to ' + vlabel + ' failed',
        (parsed.error_code || 'unknown') + ' · ' + (parsed.error_message || ''));
    }

    return parsed;
  }

  if (window.OF_pushToCrm) {
    console.warn('[of-hooks-crm-push] window.OF_pushToCrm already defined; not overwriting');
  } else {
    window.OF_pushToCrm = OF_pushToCrm;
  }
})();
