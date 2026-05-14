// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9d · AUS client hook
// File: /js/of-hooks-aus.js
//
// Implements window.OF_runAus(opts) — the hook that loan.html's "Run DU/LP/GUS"
// action calls. Thin wrapper around the run-aus edge function.
//
// Contract (matches what loan.html's promptRunAus + showAusResultModal expect):
//
//   await window.OF_runAus({
//     loanId:     string,         // required, uuid
//     engine:     'du'|'lp'|'gus', // required
//     force_mock: boolean,         // optional; when true, bypasses real vendor
//   })
//
//   →  {
//        run_id:                       string,
//        engine:                       'du'|'lp'|'gus',
//        recommendation:               string,    // vendor-native ('Approve/Eligible', 'Accept', 'Refer')
//        outcome:                      'approve'|'refer'|'ineligible'|'error',
//        decision_score:               number | null,
//        findings_summary:             string,
//        findings_count:               number,
//        required_findings_count:      number,
//        promoted_conditions_count:    number,
//        is_mock:                      boolean,
//        vendor:                       string | null,
//        duration_ms:                  number,
//        warnings:                     string[],
//      }
//
// On error, throws with the human-readable message from the edge function
// (or a generic fallback). The UI's promptRunAus catch block turns this
// into a toast.
//
// Wiring
// ──────
// Add to /loan.html in <head>, after the existing /js/of-hooks.js line:
//
//   <script src="/js/of-hooks-aus.js"></script>
//
// Or paste the body of this file into /js/of-hooks.js for a single-file
// hook bundle. The hook attaches to window so source layout is interchangeable.
//
// Prerequisites
// ─────────────
//   1. Migration 20260514000000_aus_tables.sql applied
//   2. Edge function deployed:  supabase functions deploy run-aus
//   3. Optional real-vendor env vars (when set, real adapters activate):
//        FANNIE_DU_API_KEY   — Fannie Mae DU
//        FREDDIE_LP_API_KEY  — Freddie Mac LP
//        USDA_GUS_API_KEY    — USDA GUS
//
// Without those env vars, every run is a mock run. The page's "MOCK"
// badge surfaces this loudly so users never confuse a stub run for a
// real underwriting decision.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF AUS hook] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  const VALID_ENGINES = new Set(['du', 'lp', 'gus']);

  window.OF_runAus = async function OF_runAus(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('OF_runAus requires an options object');
    }
    const { loanId, engine, force_mock } = opts;

    if (typeof loanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loanId)) {
      throw new Error('loanId (uuid) is required');
    }
    if (!VALID_ENGINES.has(engine)) {
      throw new Error('engine must be one of: du, lp, gus');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized');

    const { data, error } = await supa.functions.invoke('run-aus', {
      body: {
        loan_id: loanId,
        engine,
        force_mock: force_mock === true,
      },
    });

    // Edge-function error path #1: invoke itself failed (network, 5xx, etc.)
    if (error) {
      // supabase-js wraps non-2xx responses into FunctionsHttpError. The
      // structured error body from the edge function is usually accessible
      // via error.context.body — try that first for the most useful message.
      let msg = error.message || 'AUS function call failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json();
          if (body && typeof body.error === 'string') msg = body.error;
        }
      } catch (_) { /* swallow — fall back to error.message */ }
      throw new Error(msg);
    }

    // Edge-function error path #2: function returned 200 with { ok: false }.
    // The orchestrator does this for any non-fatal failure (loan not found,
    // permission denied, etc).
    if (!data) throw new Error('AUS returned no data');
    if (data.ok === false) {
      throw new Error(data.error || 'AUS returned an error');
    }

    // Normalize the response shape. Belt-and-suspenders defaults so the UI
    // never crashes on a missing field (e.g. if a future schema change
    // drops one).
    return {
      run_id:                    data.run_id,
      engine:                    data.engine,
      recommendation:            data.recommendation || null,
      outcome:                   data.outcome || 'error',
      decision_score:            data.decision_score ?? null,
      findings_summary:          data.findings_summary || '',
      findings_count:            Number(data.findings_count) || 0,
      required_findings_count:   Number(data.required_findings_count) || 0,
      promoted_conditions_count: Number(data.promoted_conditions_count) || 0,
      is_mock:                   data.is_mock === true,
      vendor:                    data.vendor || null,
      duration_ms:               Number(data.duration_ms) || 0,
      warnings:                  Array.isArray(data.warnings) ? data.warnings : [],
    };
  };

  window.OF_runAus.version = '9.9d';
})();
