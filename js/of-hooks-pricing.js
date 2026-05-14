// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9e · pricing client hook
// File: /js/of-hooks-pricing.js
//
// Implements window.OF_priceScenario(opts) — called from loan.html's Pricing
// tab when the LO clicks "Run pricing." Thin wrapper around the
// price-scenario edge function.
//
// Contract (matches loan.html's promptRunPricing):
//
//   await window.OF_priceScenario({
//     loanId:     string,            // required, uuid
//     force_mock: boolean,           // optional; bypass real vendor
//   })
//
//   →  {
//        scenarios_count:         number,
//        recommended_scenario_id: string | null,
//        rate_range:              { min_bps: number, max_bps: number },
//        base_rate_bps:           number,
//        llpa_bps:                number,
//        llpa_breakdown:          Array<{ name: string, bps: number }>,
//        fico_used:               number,
//        ltv_used:                number,
//        is_mock:                 boolean,
//        vendor:                  string | null,
//        rate_sheet_label:        string,
//        duration_ms:             number,
//        warnings:                string[],
//      }
//
// On error, throws with a human-readable message — promptRunPricing's catch
// block in loan.html turns this into a toast.
//
// Locking and unlocking
// ─────────────────────
// This hook does NOT lock scenarios. The page already does that directly
// via Supabase (update pricing_scenarios set locked_at = now()). The
// migration's pricing_scenarios_after_lock_trg trigger picks that up and
// rolls the rate forward to loans.rate_bps in the same transaction.
//
// The unique partial index on (loan_id) WHERE locked_at IS NOT NULL
// enforces "only one locked scenario per loan" at the schema level —
// duplicate-key violations surface as "another scenario is already locked"
// in the page's lock UX.
//
// Wiring
// ──────
// Add to /loan.html in <head>, after existing /js/of-hooks.js line:
//
//   <script src="/js/of-hooks-pricing.js"></script>
//
// Prerequisites
// ─────────────
//   1. Migration 20260514030000_pricing_scenarios.sql applied
//   2. Edge function deployed: supabase functions deploy price-scenario
//   3. Optional vendor adapter env vars (when set, real adapters activate
//      in priority order):
//        OPTIMAL_BLUE_API_KEY  — Optimal Blue (most common in mortgage)
//        POLLY_API_KEY         — Polly
//        ENCOMPASS_API_KEY     — ICE / Encompass / Ellie Mae
//
// Without those, every pricing run is a mock run — the rate sheet + LLPA
// grid in the edge function reflect realistic 2026-Q2 market values, so
// demos still feel native.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF Pricing hook] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  window.OF_priceScenario = async function OF_priceScenario(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('OF_priceScenario requires an options object');
    }
    const { loanId, force_mock } = opts;

    if (typeof loanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loanId)) {
      throw new Error('loanId (uuid) is required');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized');

    const body = {
      loan_id: loanId,
      force_mock: force_mock === true,
    };

    const { data, error } = await supa.functions.invoke('price-scenario', { body });

    if (error) {
      let msg = error.message || 'Pricing function call failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const errBody = await error.context.json();
          if (errBody && typeof errBody.error === 'string') msg = errBody.error;
        }
      } catch (_) { /* swallow */ }
      throw new Error(msg);
    }

    if (!data) throw new Error('Pricing returned no data');
    if (data.ok === false) {
      throw new Error(data.error || 'Pricing returned an error');
    }

    return {
      scenarios_count:         Number(data.scenarios_count) || 0,
      recommended_scenario_id: data.recommended_scenario_id || null,
      rate_range:              data.rate_range || { min_bps: 0, max_bps: 0 },
      base_rate_bps:           Number(data.base_rate_bps) || 0,
      llpa_bps:                Number(data.llpa_bps) || 0,
      llpa_breakdown:          Array.isArray(data.llpa_breakdown) ? data.llpa_breakdown : [],
      fico_used:               Number(data.fico_used) || 0,
      ltv_used:                Number(data.ltv_used) || 0,
      is_mock:                 data.is_mock === true,
      vendor:                  data.vendor || null,
      rate_sheet_label:        data.rate_sheet_label || '',
      duration_ms:             Number(data.duration_ms) || 0,
      warnings:                Array.isArray(data.warnings) ? data.warnings : [],
    };
  };

  window.OF_priceScenario.version = '9.9e';
})();
