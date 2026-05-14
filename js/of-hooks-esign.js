// ═══════════════════════════════════════════════════════════════════════════
// OriginFlow LOS — Patch 9.9f · eSign client hook
// File: /js/of-hooks-esign.js
//
// Implements window.OF_sendForESign(opts) — called from three places in
// loan.html:
//   • action row → promptESign() (initial_disclosures / cd / closing_docs)
//   • COC tab    → sendRevisedLeFromCoc() (revised_le)
//   • Closings   → promptSendCdFromClosing() (cd, with closing_id)
//
// Contract (matches every existing caller):
//
//   await window.OF_sendForESign({
//     loanId:          string,           // required, uuid
//     package_type:    'initial_disclosures' | 'cd' | 'closing_docs' | 'revised_le',
//     coc_id:          string | undefined,   // required for revised_le, optional otherwise
//     closing_id:      string | undefined,   // required for cd/closing_docs, optional otherwise
//     force_mock:      boolean,              // optional; bypass real vendor
//     mock_pre_signed: boolean,              // optional; create mock at status=signed
//   })
//
//   →  {
//        envelope_id:           string,  // public.esign_envelopes.id (page stamps this on source rows)
//        vendor_envelope_id:    string,  // vendor-native id
//        vendor_request_id:     string | null,
//        signing_url:           string | null,
//        package_type:          string,
//        status:                'created'|'sent'|'delivered'|'signed'|'declined'|'voided'|'expired'|'error',
//        is_mock:               boolean,
//        vendor:                string | null,
//        recipients_count:      number,
//        source_row_stamped:    'coc'|'closing_cd'|'closing_package'|null,
//        duration_ms:           number,
//        warnings:              string[],
//      }
//
// On error, throws with a human-readable message. Each caller's catch block
// in loan.html turns this into a toast.
//
// Wiring
// ──────
// Add to /loan.html in <head>, after the existing /js/of-hooks.js line:
//
//   <script src="/js/of-hooks-esign.js"></script>
//
// Or paste the body of this file into /js/of-hooks.js for a single-file
// hook bundle.
//
// Prerequisites
// ─────────────
//   1. Migration 20260514020000_esign_envelopes.sql applied
//   2. Edge function deployed: supabase functions deploy send-for-esign
//   3. Optional real-vendor env vars (when set, real adapters activate in
//      priority order):
//        DROPBOX_SIGN_API_KEY  — Dropbox Sign (formerly HelloSign)
//        DOCUSIGN_API_KEY      — DocuSign
//
// Without those, every dispatch is a mock dispatch — useful for demos
// since real vendor accounts cost money and rate-limit aggressively in
// sandbox mode.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof window.getSupabase !== 'function') {
    console.warn('[OF eSign hook] getSupabase() not available — make sure /js/config.js loads before this file.');
    return;
  }

  const VALID_PACKAGES = new Set(['initial_disclosures', 'cd', 'closing_docs', 'revised_le']);

  window.OF_sendForESign = async function OF_sendForESign(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('OF_sendForESign requires an options object');
    }
    const { loanId, package_type, coc_id, closing_id, force_mock, mock_pre_signed } = opts;

    if (typeof loanId !== 'string' || !/^[0-9a-f-]{36}$/i.test(loanId)) {
      throw new Error('loanId (uuid) is required');
    }
    if (!VALID_PACKAGES.has(package_type)) {
      throw new Error('package_type must be one of: initial_disclosures, cd, closing_docs, revised_le');
    }
    // coc_id and closing_id are validated server-side; checking client-side
    // would just duplicate the regex. We do enforce shape if provided so
    // typos surface fast.
    if (coc_id != null && (typeof coc_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(coc_id))) {
      throw new Error('coc_id must be a uuid');
    }
    if (closing_id != null && (typeof closing_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(closing_id))) {
      throw new Error('closing_id must be a uuid');
    }

    const supa = window.getSupabase();
    if (!supa) throw new Error('Supabase client not initialized');

    const body = {
      loan_id: loanId,
      package_type,
      force_mock: force_mock === true,
      mock_pre_signed: mock_pre_signed === true,
    };
    if (coc_id) body.coc_id = coc_id;
    if (closing_id) body.closing_id = closing_id;

    const { data, error } = await supa.functions.invoke('send-for-esign', { body });

    if (error) {
      let msg = error.message || 'eSign function call failed';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const errBody = await error.context.json();
          if (errBody && typeof errBody.error === 'string') msg = errBody.error;
        }
      } catch (_) { /* swallow */ }
      throw new Error(msg);
    }

    if (!data) throw new Error('eSign returned no data');
    if (data.ok === false) {
      throw new Error(data.error || 'eSign returned an error');
    }

    return {
      envelope_id:        data.envelope_id,
      vendor_envelope_id: data.vendor_envelope_id || null,
      vendor_request_id:  data.vendor_request_id || null,
      signing_url:        data.signing_url || null,
      package_type:       data.package_type,
      status:             data.status || 'sent',
      is_mock:            data.is_mock === true,
      vendor:             data.vendor || null,
      recipients_count:   Number(data.recipients_count) || 0,
      source_row_stamped: data.source_row_stamped || null,
      duration_ms:        Number(data.duration_ms) || 0,
      warnings:           Array.isArray(data.warnings) ? data.warnings : [],
    };
  };

  window.OF_sendForESign.version = '9.9f';
})();
