// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.14 · build-mismo-package client hook
// File: /js/of-hooks-mismo.js
//
// Implements window.OF_buildMismoPackage(loanId, opts?) — called from
// investor-delivery.html when the LO clicks "Build MISMO 3.4 package" in
// the build-mismo modal. Thin wrapper around the build-mismo-package
// edge function. Sibling of of-hooks-pricing.js, of-hooks-credit.js,
// of-hooks-aus.js, of-hooks-esign.js (patches 9.9c/d/e/f).
//
// Contract — matches the page's runBuildMismo() expectation:
//
//   await window.OF_buildMismoPackage(loanId, { force_mock?: boolean })
//
//   →  {
//        url:         string,        // signed URL, 1-hour TTL
//        size_bytes:  number,
//        version:     string,        // "3.4"
//        // diagnostic, optional:
//        is_mock:     boolean,
//        vendor:      string | null,
//        warnings:    string[],
//        duration_ms: number,
//        storage_path: string,
//      }
//
// On error, throws Error(message) — the page's runBuildMismo() catch
// block turns this into a toast.
//
// Why a hook and not a direct supabase.functions.invoke()
// ───────────────────────────────────────────────────────
// The same indirection as 9.9c/d/e/f:
//   • The page treats the hook as an interface; if the hook isn't
//     loaded, the page degrades gracefully ("hook not implemented" toast)
//     instead of crashing.
//   • Hooks are independently shippable — staging can run a mocked
//     hook (e.g. one that hits a local-mode mock server) while prod
//     hits the real edge function.
//   • Future swap to a different backing service (Cloudflare Worker,
//     Lambda) is a one-file change.
//
// Page-side state updates
// ───────────────────────
// The edge function is the authoritative writer for loan_deliveries —
// it updates mismo_built_at, mismo_export_url, mismo_export_size_bytes,
// and mismo_version inside the same transaction-shaped block as the
// storage upload. The page's post-hook update statement is therefore
// a redundant no-op (last-write-wins is safe). The page should
// re-load via loadAll() after the hook resolves, which it already does.
//
// Page integration
// ────────────────
// Add this script tag to investor-delivery.html before </body>:
//
//   <script src="/js/of-hooks-mismo.js"></script>
//
// Place it after the supabase-js bundle so window.supabaseClient is
// resolvable, but the hook also probes window._supa as a fallback (the
// page uses a `supa` local; this is wired through the same convention
// the other 9.9 hooks use).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Supabase client resolver ────────────────────────────────────────────
  // The page may expose the client under any of these names depending on
  // its bootstrap convention. We check in order of preference.
  function resolveSupabase() {
    if (typeof window.supabaseClient !== 'undefined' && window.supabaseClient) return window.supabaseClient;
    if (typeof window._supa          !== 'undefined' && window._supa)          return window._supa;
    if (typeof window.supa           !== 'undefined' && window.supa)           return window.supa;
    if (typeof window.sb             !== 'undefined' && window.sb)             return window.sb;
    return null;
  }

  // ── The hook itself ─────────────────────────────────────────────────────
  async function buildMismoPackage(loanId, opts) {
    if (!loanId || typeof loanId !== 'string') {
      throw new Error('window.OF_buildMismoPackage: loanId (uuid string) is required');
    }
    if (!/^[0-9a-f-]{36}$/i.test(loanId)) {
      throw new Error('window.OF_buildMismoPackage: loanId is not a valid uuid');
    }

    const supa = resolveSupabase();
    if (!supa) {
      throw new Error('Supabase client not initialized — load supabase-js before /js/of-hooks-mismo.js');
    }

    const body = {
      loan_id:    loanId,
      force_mock: Boolean(opts && opts.force_mock),
    };

    // supabase.functions.invoke() handles auth headers + URL composition
    // for us — it pulls the current session's JWT and sends it as
    // Authorization: Bearer. No need to manage tokens here.
    const { data, error } = await supa.functions.invoke('build-mismo-package', {
      body,
    });

    if (error) {
      // FunctionsHttpError, FunctionsRelayError, FunctionsFetchError all
      // surface their message via error.message. Some wrap a Response in
      // error.context; we don't depend on that — message is sufficient
      // for the page's toast.
      const msg = error.message || String(error);
      throw new Error('Edge function call failed: ' + msg);
    }
    if (!data) {
      throw new Error('Edge function returned no payload');
    }
    if (data.ok === false) {
      throw new Error(data.error || 'Edge function returned ok=false');
    }
    if (!data.url) {
      throw new Error('Edge function did not return a signed URL');
    }

    // Surface warnings to the console — the page only shows the success
    // toast, but warnings about mock fallback or missing real-adapter
    // envs are worth seeing during development.
    if (Array.isArray(data.warnings) && data.warnings.length) {
      console.warn('[OF_buildMismoPackage] warnings:', data.warnings);
    }

    return {
      url:          data.url,
      size_bytes:   data.size_bytes || 0,
      version:      data.version    || '3.4',
      is_mock:      Boolean(data.is_mock),
      vendor:       data.vendor      || null,
      warnings:     data.warnings    || [],
      duration_ms:  data.duration_ms || 0,
      storage_path: data.storage_path || null,
    };
  }

  // ── Publish ──────────────────────────────────────────────────────────────
  if (typeof window.OF_buildMismoPackage !== 'function') {
    window.OF_buildMismoPackage = buildMismoPackage;
  } else {
    console.warn('[of-hooks-mismo] window.OF_buildMismoPackage already defined — skipping re-registration');
  }
})();
