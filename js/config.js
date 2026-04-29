// ─────────────────────────────────────────────────────────────────────
//  OriginFlow LOS · Supabase client config
//  Loaded by /login.html, /signup.html, /dashboard.html
// ─────────────────────────────────────────────────────────────────────
//
//  CONFIGURED — values below are live for project zgmwtslzsmtmqcivngdq.
//
//  In your Supabase dashboard, find them at:
//    Project Settings → API → Project URL          (SUPABASE_URL)
//    Project Settings → API → publishable / anon   (SUPABASE_PUBLISHABLE_KEY)
//
//  The publishable key (sb_publishable_...) is safe to ship in client
//  code — it's protected by Row Level Security on every table.
//
//  ⚠️ NEVER paste an sb_secret_ key here. Secret keys bypass RLS.
//     If you do by mistake, rotate it immediately at Settings → API.
//
// ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL             = 'https://zgmwtslzsmtmqcivngdq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1NED7PleUmnkJH_zVM3mlg_g_KBINng';

// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Singleton — auth state lives on window._of so multiple pages share it
  function getSupabase() {
    if (!window._of) {
      if (typeof supabase === 'undefined') {
        console.error('[OF Config] Supabase JS library not loaded. Check your <script> tags.');
        return null;
      }
      if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
        console.error('[OF Config] SUPABASE_URL not configured. Edit /js/config.js.');
        return null;
      }
      // ⚠️ Safety guard — secret keys must never end up in browser code.
      // If a key starts with sb_secret_, refuse to initialize.
      if (typeof SUPABASE_PUBLISHABLE_KEY === 'string' && SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_')) {
        console.error('[OF Config] CRITICAL: sb_secret_ key detected in client config. Rotate this key immediately in Supabase → Settings → API and replace with sb_publishable_ key.');
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
    }
    return window._of;
  }

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
    if (!sb) return;
    try { await sb.auth.signOut(); } catch (err) { console.warn('[OF Config] signOut error:', err); }
    window.location.href = '/';
  }

  // Expose globally
  window.getSupabase = getSupabase;
  window.ofGetSession = ofGetSession;
  window.ofSignOut    = ofSignOut;
})();
