// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9a · OF_parseMismo34 client hook
// File: /js/of-hooks-mismo.js
//
// Implements window.OF_parseMismo34(file) for /loans-new.html's intake gate.
// Reads the dropped/picked XML as text, posts to the parse-mismo-34 edge
// function, and returns the formData-shaped object that the wizard merges
// into its state.
//
// To wire this in:
//   1. Place this file at /js/of-hooks-mismo.js (or wherever your static
//      assets live).
//   2. Add this line to /loans-new.html, BEFORE the existing inline
//      <script> block that defines bootstrap():
//        <script src="/js/of-hooks-mismo.js"></script>
//      The existing script tags for supabase-js and /js/config.js already
//      load, so this just slots in alongside them.
//
// The wizard will then detect window.OF_parseMismo34 and route MISMO drops
// through it. If you forget to include this file, the MISMO card toasts an
// "OF_parseMismo34 not configured" error and the user can still pick the
// blank intake — the page never deadlocks.
//
// Contract
// ────────
// Input:   File (XML, ≤10MB, .xml extension or application/xml MIME)
// Output:  { ...formDataKeys } — keys matching loans-new.html's `formData`.
//          Any keys NOT in formData are silently dropped by the wizard's
//          whitelist merge, so it's safe for the edge function to over-return.
// Throws:  Error on network failure, edge-function 4xx/5xx, or parser
//          rejecting the XML. The wizard catches and shows a toast.
//
// Side effects
// ────────────
// Console-logs the warnings array on success so you can see what the parser
// couldn't extract without bothering the user. The wizard separately shows
// a toast with the count of fields imported.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // Bail loudly if config.js / supabase-js haven't loaded. Should never
  // happen in practice (we're loaded after them) but the alternative is
  // a confusing "getSupabase is not a function" downstream.
  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF_parseMismo34] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  window.OF_parseMismo34 = async function OF_parseMismo34(file) {
    if (!file) throw new Error('No file provided.');

    // Read as text. MISMO 3.4 is always XML (no binary attachments at the
    // root); File.text() handles UTF-8 + BOM correctly.
    let xml;
    try {
      xml = await file.text();
    } catch (err) {
      throw new Error('Could not read file: ' + (err && err.message ? err.message : String(err)));
    }

    if (!xml || xml.length < 100) {
      throw new Error('File is empty or too short to be a MISMO 3.4 export.');
    }

    // Cheap client-side sniff. Catches users who picked the wrong file (PDF
    // saved with .xml extension, fillable form export, etc.) without
    // burning a round trip to the edge function.
    if (!xml.includes('<MESSAGE') && !xml.includes(':MESSAGE') && !xml.includes('<DEAL')) {
      throw new Error("File doesn't look like a MISMO 3.4 document (no <MESSAGE> or <DEAL> root element found).");
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized.');

    const { data, error } = await supa.functions.invoke('parse-mismo-34', {
      body: { xml },
    });

    if (error) {
      // supabase-js wraps non-2xx responses in error. The body is in
      // error.context or error.message depending on version; surface
      // whichever has more detail.
      const msg = (error && error.message) ? error.message : 'Parser invocation failed.';
      throw new Error(msg);
    }
    if (!data) throw new Error('Parser returned no data.');
    if (data.ok === false) {
      throw new Error(data.error || 'Parser returned an error.');
    }
    if (!data.formData || typeof data.formData !== 'object') {
      throw new Error('Parser returned an unexpected shape (no formData).');
    }

    // Surface warnings to the console for the LO/admin to see. The wizard
    // shows a separate toast with the success count; combining warnings
    // there would crowd the UI.
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      console.info(
        '[OF_parseMismo34] Imported %d field(s) with %d warning(s):',
        data.fieldsFilled || 0,
        data.warnings.length,
      );
      for (const w of data.warnings) console.info('  · ' + w);
    } else if (typeof data.fieldsFilled === 'number') {
      console.info('[OF_parseMismo34] Imported %d field(s), no warnings.', data.fieldsFilled);
    }

    return data.formData;
  };

  // Optional: expose a version string for debugging "is the right hook loaded?"
  window.OF_parseMismo34.version = '9.9a';
})();
