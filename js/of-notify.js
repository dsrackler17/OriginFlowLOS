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
// =============================================================================
(function () {
  async function OF_notify(template, to, data) {
    try {
      const supa = (typeof getSupabase === "function") ? getSupabase() : null;
      if (!supa) return { ok: false, error: "supabase unavailable" };
      const { data: sess } = await supa.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) return { ok: false, error: "not signed in" };

      const base = window.OF_SUPABASE_URL || window.SUPABASE_URL || "";
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
