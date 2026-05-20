// ═══════════════════════════════════════════════════════════════════════════
// /js/of-helpers.js
// ───────────────────────────────────────────────────────────────────────────
// Shared formatters and helpers for every OriginFlow LO-side HTML page.
// Include once in <head> via <script src="/js/of-helpers.js"></script>.
//
// All functions attach to `window` so they can be used unprefixed
// (money, pct, timeAgo, etc.) — matches the style already in use across
// home.html, dashboard.html, loans-new.html, and the borrower portal pages.
//
// New pages SHOULD NOT redefine these. Pages that already redefine them
// will shadow the helpers.js version with their local one — no break.
// As you touch existing pages you can delete their local copies and rely
// on this file as the single source of truth.
//
// Schema assumptions:
//   loans.loan_amount_cents       integer  — money() takes cents
//   loans.rate_bps                integer  — ratePct() takes basis points
//   loans.dti_back_pct            numeric  — pct() takes a percent already
//   loans.property_address        jsonb {street1, street2, city, state, zip}
//   loans.status                  enum     — see statusLabel/statusClass
//   loans.purpose, occupancy      enums    — see purposeLabel/occupancyLabel
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ─── MONEY ─────────────────────────────────────────────────────────────
  // money(cents) — short form for tables: $310K, $2.5M, $850
  window.money = function (cents) {
    if (cents == null) return '—';
    const n = Number(cents) / 100;
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return '$' + Math.round(n / 1_000) + 'K';
    return '$' + n.toFixed(0);
  };

  // dollars(cents) — long form for headers, disclosures: $310,000
  window.dollars = function (cents) {
    if (cents == null) return '—';
    const n = Number(cents) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  };

  // ─── PERCENTAGES ───────────────────────────────────────────────────────
  // pct(v) — DTI, LTV, etc. — takes a percent (e.g., 38.4 not 0.384)
  window.pct = function (v) {
    if (v == null) return '—';
    return Number(v).toFixed(1) + '%';
  };

  // ratePct(bps) — basis points → "6.875%"
  window.ratePct = function (bps) {
    if (bps == null) return '—';
    return (Number(bps) / 100).toFixed(3) + '%';
  };

  // ─── TIME ──────────────────────────────────────────────────────────────
  // timeAgo(iso) — relative time, mirrors Twitter/GitHub
  window.timeAgo = function (iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60)        return Math.floor(diff) + 's ago';
    if (diff < 3600)      return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400)     return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  };

  // formatDate(iso) — "Mar 14, 2026"
  window.formatDate = function (iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  };

  // formatDateTime(iso) — "Mar 14, 2026, 3:45 PM"
  window.formatDateTime = function (iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  // daysAgo(iso) — integer count, useful for status logic
  window.daysAgo = function (iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  };

  // daysUntil(iso) — negative if past
  window.daysUntil = function (iso) {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  };

  // ─── STRINGS ───────────────────────────────────────────────────────────
  window.escapeHtml = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  };

  window.titleCase = function (s) {
    if (!s) return '';
    return String(s).replace(/\w\S*/g, t =>
      t.charAt(0).toUpperCase() + t.substr(1).toLowerCase()
    );
  };

  // initials("James Rodriguez") → "JR"; falls back to first 2 chars
  window.initials = function (name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // borrowerName({first_name, last_name}) → "Rodriguez, James" or "Borrower TBD"
  window.borrowerName = function (b) {
    if (!b) return 'Borrower TBD';
    const parts = [b.last_name, b.first_name].filter(Boolean);
    if (parts.length === 0) return 'Borrower TBD';
    return parts.length === 2 ? `${parts[0]}, ${parts[1]}` : parts[0];
  };

  // borrowerNameFirstLast({first_name, last_name}) → "James Rodriguez"
  window.borrowerNameFirstLast = function (b) {
    if (!b) return 'Borrower TBD';
    return [b.first_name, b.last_name].filter(Boolean).join(' ') || 'Borrower TBD';
  };

  // ─── ADDRESSES ─────────────────────────────────────────────────────────
  // formatAddress({street1, street2, city, state, zip}) →
  //   "123 Main St, Lubbock, TX 79401"
  // Tolerates several common key shapes (street/street1, zip/zip_code/postal_code).
  window.formatAddress = function (addr) {
    if (!addr || typeof addr !== 'object') return '—';
    const line1 = addr.street1 || addr.street || '';
    const line2 = addr.street2 || '';
    const city  = addr.city  || '';
    const state = addr.state || '';
    const zip   = addr.zip || addr.zip_code || addr.postal_code || '';
    const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    return [line1, line2, cityStateZip].filter(Boolean).join(', ') || '—';
  };

  // shortAddress(addr) → "Lubbock, TX" — for tight table cells
  window.shortAddress = function (addr) {
    if (!addr || typeof addr !== 'object') return '—';
    return [addr.city, addr.state].filter(Boolean).join(', ') || '—';
  };

  // ─── LOAN STATUS ───────────────────────────────────────────────────────
  // statusLabel(s) — short uppercase for table cells / pills
  window.statusLabel = function (s) {
    return ({
      lead:'LEAD', application:'APP', submitted:'SUB', processing:'PROC',
      underwriting:'UW', conditional_approval:'COND', clear_to_close:'CTC',
      docs_out:'DOCS', funded:'FUNDED', denied:'DENIED', withdrawn:'WDRWN',
      cancelled:'CANCEL',
    })[s] || String(s || '').slice(0, 6).toUpperCase();
  };

  // statusClass(s) — for CSS color coding (matches home.html .file-status.X)
  window.statusClass = function (s) {
    return ({
      lead:'lead', application:'app', submitted:'app', processing:'proc',
      underwriting:'uw', conditional_approval:'cond', clear_to_close:'ctc',
      docs_out:'docs', funded:'funded', denied:'lead', withdrawn:'lead',
      cancelled:'lead',
    })[s] || 'lead';
  };

  // statusFullLabel(s) — long form for headers
  window.statusFullLabel = function (s) {
    return ({
      lead:                 'Lead',
      application:          'In Application',
      submitted:            'Submitted',
      processing:           'In Processing',
      underwriting:         'In Underwriting',
      conditional_approval: 'Conditional Approval',
      clear_to_close:       'Clear to Close',
      docs_out:             'Docs Out',
      funded:               'Funded',
      denied:               'Denied',
      withdrawn:            'Withdrawn',
      cancelled:            'Cancelled',
    })[s] || titleCase(s || 'Unknown');
  };

  // mapStatusToStage(s) — milestone index 0..7 for progress bars
  window.mapStatusToStage = function (s) {
    return ({
      lead:                 0,
      application:          1,
      submitted:            2,
      processing:           3,
      underwriting:         4,
      conditional_approval: 4,
      clear_to_close:       5,
      docs_out:             6,
      funded:               7,
      denied:              -1,
      withdrawn:           -1,
      cancelled:           -1,
    })[s] ?? 0;
  };

  // ─── ENUM LABELS ───────────────────────────────────────────────────────
  window.purposeLabel = function (p) {
    return ({
      purchase:           'Purchase',
      refinance:          'Refinance',
      cash_out_refinance: 'Cash-out Refi',
      heloc:              'HELOC',
      construction:       'Construction',
    })[p] || titleCase(p || '—');
  };

  window.occupancyLabel = function (o) {
    return ({
      primary:    'Primary Residence',
      secondary:  'Second Home',
      investment: 'Investment Property',
    })[o] || titleCase(o || '—');
  };

  window.propertyTypeLabel = function (t) {
    return ({
      single_family:      'Single Family',
      condo:              'Condominium',
      townhouse:          'Townhouse',
      two_to_four:        '2–4 Unit',
      manufactured:       'Manufactured',
      pud:                'PUD',
      coop:               'Co-op',
    })[t] || titleCase(t || '—');
  };

  // termLabel(months) → "30 yr fixed" doesn't know amortization, so just term
  window.termLabel = function (months) {
    if (!months) return '—';
    const yrs = Math.round(months / 12);
    return yrs + ' yr';
  };

  // ─── DOM HELPERS ───────────────────────────────────────────────────────
  window.$ = window.$ || (sel => document.querySelector(sel));
  window.$$ = window.$$ || (sel => Array.from(document.querySelectorAll(sel)));

  // ─── PLATFORM ──────────────────────────────────────────────────────────
  window.OF_isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

})();
