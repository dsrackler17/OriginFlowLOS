// =============================================================================
// /js/of-notify.js — client helper for the send-notification edge function
// Exposes window.OF_notify(template, to, data) → Promise<{ok,id}|{ok:false,error}>
// -----------------------------------------------------------------------------
// Usage (any authenticated page that already has getSupabase()):
//   await OF_notify('document_request', borrowerEmail, {
//     branchName: branch.name, firstName, loanNumber, path: '/portal_docs.html',
//     items: ['2024 W-2', 'Last 2 pay stubs']
//   });
// `path` is turned into a full link by the edge function via APP_BASE_URL; or
// pass an absolute `link` directly.
//
// Templates available: borrower_invite, document_request, status_update,
// decision_ready. (Never send decision REASONS by email — decision_ready is a
// "sign in to view" notice only.)
//
// [2026-05-25] Base-URL resolution hardened: falls back to getSupabase()'s own
// configured URL, then the prod constant, so a page that loads config.js but
// doesn't expose window.SUPABASE_URL no longer fetches against the wrong origin.
// =============================================================================
(function () {
  // Prod project URL — last-resort fallback so OF_notify always hits the right
  // origin even if a page forgot to set window.SUPABASE_URL. Matches config.js.
  var OF_PROD_SUPABASE_URL = "https://zgmwtslzsmtmqcivngdq.supabase.co";

  function resolveBase(supa) {
    // 1) explicit globals  2) the client's own configured URL  3) prod constant
    var fromGlobal = window.OF_SUPABASE_URL || window.SUPABASE_URL;
    if (fromGlobal) return String(fromGlobal).replace(/\/+$/, "");
    try {
      var u = supa && (supa.supabaseUrl || (supa.rest && supa.rest.url));
      if (u) return String(u).replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
    } catch (_) { /* ignore */ }
    return OF_PROD_SUPABASE_URL;
  }

  async function OF_notify(template, to, data) {
    try {
      const supa = (typeof getSupabase === "function") ? getSupabase() : null;
      if (!supa) return { ok: false, error: "supabase unavailable" };
      const { data: sess } = await supa.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) return { ok: false, error: "not signed in" };
      const base = resolveBase(supa);
      const res = await fetch(`${base}/functions/v1/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ template, to, data: data || {} }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
      return body;
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
  window.OF_notify = OF_notify;
})();
