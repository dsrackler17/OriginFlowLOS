// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9c · credit pull client hook
// File: /js/of-hooks-credit.js
//
// Implements window.OF_pullCredit(opts) — the hook that loan.html's
// "Pull credit" action (from the Borrowers tab) calls. Thin wrapper around
// the pull-credit edge function.
//
// Contract (matches what loan.html's promptPullCredit expects):
//
//   await window.OF_pullCredit({
//     loanId:     string,                  // required, uuid
//     borrowerId: string,                  // required, uuid
//     bureau:     'equifax'|'experian'|'transunion',  // optional; omit for tri-merge
//     force_mock: boolean,                 // optional; bypass real vendor
//   })
//
//   →  {
//        pull_id:                     string,
//        borrower_id:                 string,
//        score_equifax:               number | null,
//        score_experian:              number | null,
//        score_transunion:            number | null,
//        representative_score:        number | null,
//        tradelines_count:            number,
//        inquiries_count:             number,
//        inquiries_last_90d_count:    number,
//        public_records_count:        number,
//        collections_count:           number,
//        is_mock:                     boolean,
//        vendor:                      string | null,
//        pulled_at:                   string,    // ISO timestamp
//        duration_ms:                 number,
//        warnings:                    string[],
//      }
//
// On error, throws with the human-readable message from the edge function.
// promptPullCredit's catch block in loan.html turns this into a toast.
//
// Wiring
// ──────
// Add to /loan.html in <head>, after the existing /js/of-hooks.js line:
//
//   <script src="/js/of-hooks-credit.js"></script>
//
// Or paste the body of this file into /js/of-hooks.js for a single-file
// hook bundle.
//
// Prerequisites
// ─────────────
//   1. Migration 20260514010000_credit_pulls.sql applied
//   2. Edge function deployed: supabase functions deploy pull-credit
//   3. Optional real-vendor env vars (when set, real adapters activate
//      in priority order):
//        MERIDIANLINK_API_KEY  — MeridianLink LiquidCredit (primary)
//        FACTUAL_DATA_API_KEY  — FactualData
//        CREDCO_API_KEY        — CoreLogic CredCo
//
// Without those, every pull is a mock pull — the UI's "Pulled ⌛ ago" line
// looks identical, but the loan.html Borrowers tab can flag is_mock if
// desired (currently it doesn't — same as AUS is_mock surfacing pattern).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF Credit hook] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  const VALID_BUREAUS = new Set(['equifax', 'experian', 'transunion']);

  window.OF_pullCredit = async function OF_pullCredit(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('OF_pullCredit requires an options object');
    }
    const { loanId, borrowerId, bureau, force_mock } = opts;

    if (typeof loanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loanId)) {
      throw new Error('loanId (uuid) is required');
    }
    if (typeof borrowerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(borrowerId)) {
      throw new Error('borrowerId (uuid) is required');
    }
    if (bureau != null && !VALID_BUREAUS.has(bureau)) {
      throw new Error('bureau must be one of: equifax, experian, transunion (or omit for tri-merge)');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized');

    const body = {
      loan_id: loanId,
      borrower_id: borrowerId,
      force_mock: force_mock === true,
    };
    if (bureau) body.bureau = bureau;

    const { data, error } = await supa.functions.invoke('pull-credit', { body });

    // Error path #1: invoke itself failed
    if (error) {
      let msg = error.message || 'Credit pull function call failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const errBody = await error.context.json();
          if (errBody && typeof errBody.error === 'string') msg = errBody.error;
        }
      } catch (_) { /* swallow — fall back to error.message */ }
      throw new Error(msg);
    }

    // Error path #2: function returned 200 with { ok: false }
    if (!data) throw new Error('Credit pull returned no data');
    if (data.ok === false) {
      throw new Error(data.error || 'Credit pull returned an error');
    }

    // Normalize the response shape. Belt-and-suspenders defaults so the UI
    // never crashes on a missing field.
    return {
      pull_id:                  data.pull_id,
      borrower_id:              data.borrower_id,
      score_equifax:            data.score_equifax ?? null,
      score_experian:           data.score_experian ?? null,
      score_transunion:         data.score_transunion ?? null,
      representative_score:     data.representative_score ?? null,
      tradelines_count:         Number(data.tradelines_count) || 0,
      inquiries_count:          Number(data.inquiries_count) || 0,
      inquiries_last_90d_count: Number(data.inquiries_last_90d_count) || 0,
      public_records_count:     Number(data.public_records_count) || 0,
      collections_count:        Number(data.collections_count) || 0,
      is_mock:                  data.is_mock === true,
      vendor:                   data.vendor || null,
      pulled_at:                data.pulled_at || new Date().toISOString(),
      duration_ms:              Number(data.duration_ms) || 0,
      warnings:                 Array.isArray(data.warnings) ? data.warnings : [],
    };
  };

  window.OF_pullCredit.version = '9.9c';
})();
