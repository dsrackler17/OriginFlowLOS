// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS · Supabase client config
// Loaded by every page that talks to Supabase (login, signup, home,
// dashboard, documents, checkout, etc.).
//
// ─── WHAT CHANGED FROM THE OLD CONFIG ─────────────────────────────────────
//
// The previous version declared SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
// as top-level `const`s, which made them live at global script scope.
// Other pages (notably the old checkout.html) tried to redeclare
// `const SUPABASE_URL = ...` to re-derive the value, which is a hard
// SyntaxError at parse time. That meant any page with its own SUPABASE_URL
// declaration was failing to load before any of its other JS ran.
//
// New approach:
//   1. Constants live INSIDE the IIFE — no global script-scope const.
//   2. We expose them on `window` as plain properties (not const), so
//      `window.SUPABASE_URL` and `window.OF_SUPABASE_URL` are both safe
//      to read and even reassign without collisions.
//   3. Existing helpers (getSupabase, ofGetSession, ofSignOut) keep the
//      same signatures, so no other page needs to change.
//
// ─── KEY HYGIENE ──────────────────────────────────────────────────────────
//
// The PUBLISHABLE key (sb_publishable_*) is safe to ship to the browser —
// it only allows operations permitted by your RLS policies. If you ever
// see `sb_secret_*` here, it's been leaked: rotate immediately in the
// Supabase dashboard. The runtime check below will refuse to instantiate
// a client with a secret key and log a CRITICAL warning instead of
// silently exfiltrating it on every request.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  const SUPABASE_URL             = 'https://zgmwtslzsmtmqcivngdq.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1NED7PleUmnkJH_zVM3mlg_g_KBINng';

  // Expose on window for any page that wants to read them directly (e.g.,
  // for calling edge functions via fetch with explicit URLs). Use property
  // assignment, NOT `const window.X = ...`, so pages can safely re-read or
  // even override these in tests without triggering a SyntaxError.
  window.OF_SUPABASE_URL              = SUPABASE_URL;
  window.OF_SUPABASE_PUBLISHABLE_KEY  = SUPABASE_PUBLISHABLE_KEY;
  // Back-compat aliases — older pages may reference these unprefixed
  // names. Safe because they're plain props, not const declarations.
  window.SUPABASE_URL                 = SUPABASE_URL;
  window.SUPABASE_PUBLISHABLE_KEY     = SUPABASE_PUBLISHABLE_KEY;

  // ─── CLIENT FACTORY ──────────────────────────────────────────────────────
  //
  // Memoized on window._of so every page shares one client instance. This
  // matters for auth state: if two clients exist, the second won't see
  // session changes (sign-in/sign-out) made through the first.
  function getSupabase() {
    if (window._of) return window._of;

    if (typeof supabase === 'undefined') {
      console.error('[OF Config] Supabase JS library not loaded. Check your <script> tags — supabase-js@2 UMD must load before config.js.');
      return null;
    }
    if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
      console.error('[OF Config] SUPABASE_URL not configured. Edit /js/config.js.');
      return null;
    }
    if (typeof SUPABASE_PUBLISHABLE_KEY === 'string' &&
        SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_')) {
      // Hard refusal: shipping a service-role/secret key to the browser
      // bypasses every RLS policy and effectively makes the entire database
      // public. Don't instantiate the client and don't continue.
      console.error('[OF Config] CRITICAL: sb_secret_ key detected in client config. This is a service-role key and bypasses RLS. Rotate in the Supabase dashboard IMMEDIATELY and replace with an sb_publishable_ key.');
      return null;
    }

    window._of = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
      },
    });
    return window._of;
  }

  // ─── SESSION HELPERS ─────────────────────────────────────────────────────

  async function ofGetSession() {
    const sb = getSupabase();
    if (!sb) return null;
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) {
        console.warn('[OF Config] getSession error:', error.message);
        return null;
      }
      return data?.session || null;
    } catch (err) {
      console.warn('[OF Config] getSession threw:', err);
      return null;
    }
  }

  async function ofSignOut() {
    const sb = getSupabase();
    if (sb) {
      try { await sb.auth.signOut(); }
      catch (err) { console.warn('[OF Config] signOut error:', err); }
    }
    window.location.href = '/';
  }

  // ─── GLOBAL EXPORTS ──────────────────────────────────────────────────────
  // Both `getSupabase` and `ofSupabase` are exposed because different pages
  // standardized on different names. Don't remove either without grepping
  // every HTML file in the project first.
  window.getSupabase  = getSupabase;
  window.ofSupabase   = getSupabase;
  window.ofGetSession = ofGetSession;
  window.ofSignOut    = ofSignOut;
})();
