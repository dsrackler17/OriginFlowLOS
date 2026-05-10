// ═══════════════════════════════════════════════════════════════════════════
// /js/disclosure-pdf.js
//
// OriginFlow LOS · Disclosure PDF generator (Loan Estimate, Intent to
// Proceed, package assembly). Round 4 — eSign + disclosures.
//
// Generates TRID disclosure PDFs from loan data IN THE BROWSER, with no
// backend dependency. Used by:
//   - eSign dispatch flow (loan.html "Send for eSign" → this module
//     produces the PDF, of-hooks.js sends to Dropbox Sign)
//   - COC revised-LE generation when fees bust tolerance
//   - Future: closing workflow uses the same primitives for CD generation
//
// Approach: generates from scratch with pdf-lib drawing primitives. This is
// a reasonable approximation of CFPB Form H-24 (Loan Estimate) — close
// enough to dispatch through eSign for a working production loan, but NOT
// a pixel-perfect H-24. Real lenders WILL want a pixel-perfect H-24
// eventually; for that, swap to filling the official CFPB blank fillable
// PDF using pdf-lib's PDFForm.getTextField() API. The data flow stays the
// same; only the rendering layer swaps. The blank H-24 is at:
//   https://www.consumerfinance.gov/owning-a-home/loan-estimate/
//
// Loaded as a plain script tag, exposes window.OFDisclosure. pdf-lib is
// lazy-loaded from jsDelivr the first time something in this module is
// called, so pages that never trigger PDF generation pay no overhead.
//
// Public API (all return Promise<Uint8Array>):
//   OFDisclosure.generateLoanEstimate(loanData)
//   OFDisclosure.generateIntentToProceed(loanData)
//   OFDisclosure.generateInitialDisclosurePackage(loanData)
//
// loanData shape — match what the loan.html bootstrap query already
// produces, plus the fees array from the new fees table:
//   {
//     loan_number, loan_amount_cents, rate_bps, term_months, program,
//     purpose, occupancy, property_address: { street, unit, city, state,
//     zip }, purchase_price_cents, appraised_value_cents, lock_expires_at,
//     le_sent_at,
//     borrowers: [{ first_name, last_name, ssn_last4, dob, email, phone }],
//     fees: [{ section, description, payee, tolerance_bucket,
//              borrower_paid_at_closing_cents, ... }],
//     pricing: { rate_bps, points, monthly_pi_cents } | null,
//     branch: { name, nmls_id, license_number, address }
//   }
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── pdf-lib LAZY LOADER ─────────────────────────────────────────────────
  let _pdfLibPromise = null;
  function loadPdfLib() {
    if (_pdfLibPromise) return _pdfLibPromise;
    _pdfLibPromise = new Promise(function (resolve, reject) {
      if (typeof window.PDFLib !== 'undefined') return resolve(window.PDFLib);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      s.async = true;
      s.onload = function () {
        if (typeof window.PDFLib !== 'undefined') resolve(window.PDFLib);
        else reject(new Error('pdf-lib loaded but window.PDFLib global not found'));
      };
      s.onerror = function () {
        reject(new Error('Failed to load pdf-lib from CDN — check network connection'));
      };
      document.head.appendChild(s);
    });
    return _pdfLibPromise;
  }

  // ─── PAGE CONSTANTS ──────────────────────────────────────────────────────
  // pdf-lib uses points (1pt = 1/72"). Origin is bottom-left of the page.
  // All draw helpers below take "topY" (distance from page top) and convert.
  var PAGE_W = 612;   // US Letter
  var PAGE_H = 792;
  var MARGIN = 36;    // 0.5"
  var CONTENT_W = PAGE_W - 2 * MARGIN;

  // Type sizes, kept tight to fit H-24's dense layout.
  var SZ_TITLE   = 18;
  var SZ_SECTION = 11;
  var SZ_LABEL   = 7;
  var SZ_BODY    = 9;
  var SZ_SMALL   = 7;
  var SZ_FOOT    = 6.5;

  // ─── FORMATTERS ──────────────────────────────────────────────────────────
  function moneyWhole(c) {
    if (c == null) return '—';
    return '$' + (Number(c) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
  }
  function moneyExact(c) {
    if (c == null) return '—';
    return '$' + (Number(c) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  function rate(bps) {
    if (bps == null) return '—';
    return (Number(bps) / 100).toFixed(3) + '%';
  }
  function term(months) {
    if (months == null) return '—';
    return Math.round(months / 12) + ' years';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  }
  function fullName(b) {
    if (!b) return '';
    return ((b.first_name || '') + ' ' + (b.last_name || '')).trim();
  }
  function fullAddressOneLine(addr) {
    if (!addr) return '—';
    var parts = [];
    if (addr.street) parts.push(addr.street);
    if (addr.unit) parts.push('Unit ' + addr.unit);
    var locality = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
    if (locality) parts.push(locality);
    return parts.join(', ') || '—';
  }
  function programLabel(p) {
    if (!p) return 'Conventional';
    return ({
      conv: 'Conventional', conventional: 'Conventional',
      fha: 'FHA', va: 'VA', usda: 'USDA',
      jumbo: 'Jumbo', non_qm: 'Non-QM',
    })[String(p).toLowerCase()] ||
      (String(p).charAt(0).toUpperCase() + String(p).slice(1));
  }
  function purposeLabel(p) {
    if (!p) return 'Purchase';
    return ({
      purchase: 'Purchase', refinance: 'Refinance',
      cashout_refinance: 'Cash-Out Refinance',
      construction: 'Construction', renovation: 'Renovation',
    })[String(p).toLowerCase()] || String(p).replace(/_/g, ' ');
  }

  // Compute the principal-and-interest payment from loan amount, rate
  // (basis points), and term (months). Returns cents. Used as fallback
  // when pricing.monthly_pi_cents isn't on the loan data.
  function computeMonthlyPI(loanAmountCents, rateBps, termMonths) {
    if (!loanAmountCents || rateBps == null || !termMonths) return null;
    var P = Number(loanAmountCents) / 100;
    var r = (Number(rateBps) / 10000) / 12;
    var n = Number(termMonths);
    if (r === 0) return Math.round((P / n) * 100);
    var pi = (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    return Math.round(pi * 100);
  }

  // Sum the five paid-by columns on a fee row. Tolerates missing cols.
  function feeTotalCents(f) {
    return (Number(f.borrower_paid_at_closing_cents)     || 0)
         + (Number(f.borrower_paid_before_closing_cents) || 0)
         + (Number(f.seller_paid_at_closing_cents)       || 0)
         + (Number(f.seller_paid_before_closing_cents)   || 0)
         + (Number(f.paid_by_others_cents)               || 0);
  }

  // ─── DRAW HELPERS ────────────────────────────────────────────────────────
  // Top-anchored coordinate model: callers think "30 points down from the
  // top of the page", this layer flips to pdf-lib's bottom-anchored y.
  function makeCtx(page, fonts, lib) {
    return {
      page: page, fontReg: fonts.reg, fontBold: fonts.bold, lib: lib,
      ty: function (topY) { return PAGE_H - topY; },
    };
  }

  function drawText(ctx, text, x, topY, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : SZ_BODY;
    var bold = !!opts.bold;
    var color = opts.color || ctx.lib.rgb(0, 0, 0);
    ctx.page.drawText(String(text == null ? '' : text), {
      x: x,
      y: ctx.ty(topY) - size + 1,   // pdf-lib draws from baseline
      size: size,
      font: bold ? ctx.fontBold : ctx.fontReg,
      color: color,
      maxWidth: opts.maxWidth,
    });
  }

  function drawTextRight(ctx, text, xRight, topY, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : SZ_BODY;
    var font = opts.bold ? ctx.fontBold : ctx.fontReg;
    var w = font.widthOfTextAtSize(String(text == null ? '' : text), size);
    drawText(ctx, text, xRight - w, topY, opts);
  }

  function wrapText(text, font, size, maxWidth) {
    if (!text) return [''];
    var words = String(text).split(/\s+/);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
        lines.push(cur);
        cur = words[i];
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawWrapped(ctx, text, x, topY, maxWidth, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : SZ_BODY;
    var font = opts.bold ? ctx.fontBold : ctx.fontReg;
    var leading = opts.leading || (size + 2);
    var lines = wrapText(text, font, size, maxWidth);
    for (var i = 0; i < lines.length; i++) {
      drawText(ctx, lines[i], x, topY + i * leading, opts);
    }
    return topY + lines.length * leading;
  }

  function drawBox(ctx, x, topY, w, h, opts) {
    opts = opts || {};
    var draw = {
      x: x, y: ctx.ty(topY) - h, width: w, height: h,
      borderWidth: opts.borderWidth != null ? opts.borderWidth : 0.75,
      borderColor: opts.borderColor || ctx.lib.rgb(0, 0, 0),
    };
    if (opts.fill) draw.color = opts.fill;
    ctx.page.drawRectangle(draw);
  }

  function drawHLine(ctx, x1, x2, topY, opts) {
    opts = opts || {};
    ctx.page.drawLine({
      start: { x: x1, y: ctx.ty(topY) },
      end:   { x: x2, y: ctx.ty(topY) },
      thickness: opts.thickness || 0.5,
      color: opts.color || ctx.lib.rgb(0, 0, 0),
    });
  }

  // Label/value pair (small label on top, body value below). Returns next topY.
  function drawLabelValue(ctx, x, topY, w, label, value, opts) {
    opts = opts || {};
    drawText(ctx, label, x, topY, { size: SZ_LABEL, bold: true });
    var valTopY = topY + SZ_LABEL + 2;
    drawText(ctx, value, x, valTopY, { size: SZ_BODY, maxWidth: w });
    return valTopY + SZ_BODY + 4;
  }

  // Black bar with white text — section divider on H-24.
  function drawSectionBar(ctx, x, topY, w, label) {
    var h = SZ_SECTION + 6;
    ctx.page.drawRectangle({
      x: x, y: ctx.ty(topY) - h, width: w, height: h,
      color: ctx.lib.rgb(0, 0, 0),
    });
    drawText(ctx, label, x + 6, topY + 4, {
      size: SZ_SECTION, bold: true, color: ctx.lib.rgb(1, 1, 1),
    });
    return topY + h;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LOAN ESTIMATE — page 1 of 3
  //
  // Layout closely follows H-24 page 1: title bar, applicant/property top
  // box, "Loan Terms" box, "Projected Payments" box, "Costs at Closing" box.
  // ═════════════════════════════════════════════════════════════════════════
  function drawLEPage1(ctx, data) {
    var x = MARGIN;
    var y = MARGIN;
    var w = CONTENT_W;

    // ── TITLE & RIGHT-RAIL DESCRIPTION ──
    drawText(ctx, 'Loan Estimate', x, y, { size: SZ_TITLE, bold: true });
    drawText(ctx, 'Save this Loan Estimate to compare with your Closing Disclosure.',
      x + 250, y + 4, { size: SZ_SMALL });
    y += SZ_TITLE + 8;
    drawHLine(ctx, x, x + w, y, { thickness: 1.5 });
    y += 8;

    // ── APPLICANT/PROPERTY TOP BOX ──
    // 3 columns: Date Issued / Applicants / Property | Sale Price / Loan Term / Purpose | Product / Loan Type / Loan ID # / Rate Lock
    var topBoxH = 110;
    drawBox(ctx, x, y, w, topBoxH);
    var col1 = x + 8;
    var col2 = x + w / 3 + 8;
    var col3 = x + (2 * w) / 3 + 8;
    var colW = (w / 3) - 16;
    var ty = y + 6;

    var applicantNames = (data.borrowers || [])
      .map(fullName).filter(Boolean).join('; ') || '—';
    var applicantAddress = data.borrowers && data.borrowers[0] && data.borrowers[0].mailing_address
      ? fullAddressOneLine(data.borrowers[0].mailing_address)
      : 'See file';

    var ty1 = ty;
    ty1 = drawLabelValue(ctx, col1, ty1, colW, 'DATE ISSUED', fmtDate(data.le_sent_at || new Date().toISOString()));
    ty1 = drawLabelValue(ctx, col1, ty1, colW, 'APPLICANTS', applicantNames);
    ty1 = drawLabelValue(ctx, col1, ty1, colW, 'PROPERTY', fullAddressOneLine(data.property_address));

    var ty2 = ty;
    ty2 = drawLabelValue(ctx, col2, ty2, colW, 'SALE PRICE',
      data.purpose === 'refinance' || data.purpose === 'cashout_refinance'
        ? 'Est. Property Value: ' + moneyWhole(data.appraised_value_cents)
        : moneyWhole(data.purchase_price_cents));
    ty2 = drawLabelValue(ctx, col2, ty2, colW, 'LOAN TERM', term(data.term_months));
    ty2 = drawLabelValue(ctx, col2, ty2, colW, 'PURPOSE', purposeLabel(data.purpose));

    var ty3 = ty;
    ty3 = drawLabelValue(ctx, col3, ty3, colW, 'PRODUCT',
      'Fixed Rate · ' + term(data.term_months));
    ty3 = drawLabelValue(ctx, col3, ty3, colW, 'LOAN TYPE',
      'X ' + programLabel(data.program));
    ty3 = drawLabelValue(ctx, col3, ty3, colW, 'LOAN ID #', data.loan_number || '—');
    var lockText = data.lock_expires_at
      ? 'YES · Until ' + fmtDate(data.lock_expires_at)
      : 'NO · Subject to change';
    ty3 = drawLabelValue(ctx, col3, ty3, colW, 'RATE LOCK', lockText);

    y += topBoxH + 10;

    // ── LOAN TERMS BOX ──
    y = drawSectionBar(ctx, x, y, w, 'Loan Terms');

    // 4 columns: blank label area | "Can this amount increase after closing?"
    // Each row: label, value, Y/N + explanation
    var ltLabelW = 130;
    var ltValueW = 160;
    var ltCanW = w - ltLabelW - ltValueW;

    // Header row
    drawText(ctx, '', x + 4, y + 3);
    drawText(ctx, '', x + ltLabelW + 4, y + 3);
    drawText(ctx, 'Can this amount increase after closing?', x + ltLabelW + ltValueW + 4, y + 4,
      { size: SZ_SMALL, bold: true });
    y += SZ_SECTION + 4;

    // Row 1: Loan Amount
    drawHLine(ctx, x, x + w, y);
    drawText(ctx, 'Loan Amount', x + 6, y + 6, { size: SZ_BODY, bold: true });
    drawText(ctx, moneyWhole(data.loan_amount_cents), x + ltLabelW + 6, y + 6, { size: SZ_BODY });
    drawText(ctx, 'NO', x + ltLabelW + ltValueW + 6, y + 6, { size: SZ_BODY, bold: true });
    y += 22;

    // Row 2: Interest Rate
    drawHLine(ctx, x, x + w, y);
    drawText(ctx, 'Interest Rate', x + 6, y + 6, { size: SZ_BODY, bold: true });
    drawText(ctx, rate(data.rate_bps), x + ltLabelW + 6, y + 6, { size: SZ_BODY });
    drawText(ctx, 'NO', x + ltLabelW + ltValueW + 6, y + 6, { size: SZ_BODY, bold: true });
    y += 22;

    // Row 3: Monthly P&I
    var monthlyPI = (data.pricing && data.pricing.monthly_pi_cents)
      || computeMonthlyPI(data.loan_amount_cents, data.rate_bps, data.term_months);
    drawHLine(ctx, x, x + w, y);
    drawText(ctx, 'Monthly Principal & Interest', x + 6, y + 6, { size: SZ_BODY, bold: true });
    drawText(ctx, moneyWhole(monthlyPI), x + ltLabelW + 6, y + 6, { size: SZ_BODY });
    drawText(ctx, 'NO', x + ltLabelW + ltValueW + 6, y + 6, { size: SZ_BODY, bold: true });
    y += 22;

    // Sub-row under loan terms: prepayment penalty / balloon
    drawHLine(ctx, x, x + w, y);
    y += 6;
    drawText(ctx, 'Does the loan have these features?',
      x + 6, y, { size: SZ_SMALL, bold: true });
    y += 14;
    drawText(ctx, 'Prepayment Penalty', x + 6, y, { size: SZ_BODY, bold: true });
    drawText(ctx, 'NO', x + ltLabelW + 6, y, { size: SZ_BODY });
    y += 12;
    drawText(ctx, 'Balloon Payment', x + 6, y, { size: SZ_BODY, bold: true });
    drawText(ctx, 'NO', x + ltLabelW + 6, y, { size: SZ_BODY });
    y += 14;
    drawHLine(ctx, x, x + w, y, { thickness: 0.75 });
    y += 12;

    // ── PROJECTED PAYMENTS BOX ──
    y = drawSectionBar(ctx, x, y, w, 'Projected Payments');
    var ppBoxH = 115;
    drawBox(ctx, x, y, w, ppBoxH);

    drawText(ctx, 'Payment Calculation', x + 6, y + 6, { size: SZ_SMALL, bold: true });
    drawText(ctx, 'Years 1 – ' + Math.round((data.term_months || 360) / 12), x + 6, y + 18,
      { size: SZ_BODY, bold: true });

    var sectionMidX = x + w / 2;
    drawText(ctx, 'Principal & Interest', x + 6, y + 36, { size: SZ_BODY });
    drawTextRight(ctx, moneyWhole(monthlyPI), sectionMidX - 8, y + 36, { size: SZ_BODY });

    drawText(ctx, 'Mortgage Insurance', x + 6, y + 50, { size: SZ_BODY });
    drawTextRight(ctx, '+  $0', sectionMidX - 8, y + 50, { size: SZ_BODY });
    drawText(ctx, 'Estimated Escrow', x + 6, y + 64, { size: SZ_BODY });
    drawText(ctx, 'Amount can increase over time', x + 6, y + 74,
      { size: SZ_FOOT, color: ctx.lib.rgb(0.4, 0.4, 0.4) });
    drawTextRight(ctx, '+  See file', sectionMidX - 8, y + 64, { size: SZ_BODY });

    drawHLine(ctx, x + 4, sectionMidX - 4, y + 88);
    drawText(ctx, 'Estimated Total', x + 6, y + 94, { size: SZ_SMALL, bold: true });
    drawText(ctx, 'Monthly Payment', x + 6, y + 94 + SZ_SMALL + 1, { size: SZ_SMALL, bold: true });
    drawTextRight(ctx, moneyWhole(monthlyPI), sectionMidX - 8, y + 94, { size: SZ_BODY, bold: true });

    // Right side: estimated taxes / insurance / assessments
    drawText(ctx, 'Estimated Taxes, Insurance', sectionMidX + 8, y + 6, { size: SZ_SMALL, bold: true });
    drawText(ctx, '& Assessments', sectionMidX + 8, y + 6 + SZ_SMALL + 2, { size: SZ_SMALL, bold: true });
    drawText(ctx, 'See file', sectionMidX + 8, y + 28, { size: SZ_BODY, bold: true });
    drawText(ctx, 'a month', sectionMidX + 8, y + 28 + SZ_BODY + 2, { size: SZ_SMALL });
    drawText(ctx, 'This estimate includes', sectionMidX + 8, y + 60, { size: SZ_FOOT });
    drawText(ctx, '[X] Property Taxes', sectionMidX + 8, y + 72, { size: SZ_FOOT });
    drawText(ctx, '[X] Homeowner\u2019s Insurance', sectionMidX + 8, y + 82, { size: SZ_FOOT });
    drawText(ctx, '[ ] Other:', sectionMidX + 8, y + 92, { size: SZ_FOOT });

    y += ppBoxH + 12;

    // ── COSTS AT CLOSING BOX ──
    y = drawSectionBar(ctx, x, y, w, 'Costs at Closing');
    var ccBoxH = 80;
    drawBox(ctx, x, y, w, ccBoxH);

    var totalClosingCents = (data.fees || []).reduce(function (s, f) {
      return s + feeTotalCents(f);
    }, 0);

    var halfW = w / 2;
    drawText(ctx, 'Estimated Closing Costs', x + 6, y + 6, { size: SZ_SMALL, bold: true });
    drawText(ctx, moneyWhole(totalClosingCents), x + 6, y + 22, { size: SZ_TITLE - 4, bold: true });
    drawText(ctx, 'Includes Total Loan Costs (D) + Other Costs (I) -', x + 6, y + 50,
      { size: SZ_FOOT });
    drawText(ctx, 'Lender Credits. See page 2 for details.', x + 6, y + 58, { size: SZ_FOOT });

    var cashToClose = totalClosingCents +
      ((Number(data.purchase_price_cents) || 0) - (Number(data.loan_amount_cents) || 0));
    drawText(ctx, 'Estimated Cash to Close', x + halfW + 8, y + 6, { size: SZ_SMALL, bold: true });
    drawText(ctx, moneyWhole(cashToClose), x + halfW + 8, y + 22, { size: SZ_TITLE - 4, bold: true });
    drawText(ctx, 'Includes Closing Costs. See Calculating Cash', x + halfW + 8, y + 50,
      { size: SZ_FOOT });
    drawText(ctx, 'to Close on page 2 for details.', x + halfW + 8, y + 58, { size: SZ_FOOT });

    y += ccBoxH + 12;

    // ── FOOTER ──
    drawPageFooter(ctx, data, 1, 3);
  }

  function drawPageFooter(ctx, data, pageNum, totalPages, docLabel) {
    var y = PAGE_H - MARGIN + 6;
    drawHLine(ctx, MARGIN, PAGE_W - MARGIN, y - 12, { thickness: 0.5 });
    var loanLabel = 'LOAN ID # ' + (data.loan_number || '—');
    drawText(ctx, loanLabel, MARGIN, y - 4, { size: SZ_FOOT, bold: true });
    drawTextRight(ctx, 'PAGE ' + pageNum + ' OF ' + totalPages + ' · ' + (docLabel || 'LOAN ESTIMATE'),
      PAGE_W - MARGIN, y - 4, { size: SZ_FOOT, bold: true });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LOAN ESTIMATE — page 2 of 3 · Closing Cost Details
  //
  // Sections A through J. Reads from data.fees, groups by section letter.
  // D = A+B+C (Total Loan Costs), I = E+F+G+H (Total Other Costs),
  // J = D+I (Total Closing Costs).
  // ═════════════════════════════════════════════════════════════════════════

  var FEE_SECTIONS = [
    ['A', 'Origination Charges',                 'loan_costs'],
    ['B', 'Services You Cannot Shop For',        'loan_costs'],
    ['C', 'Services You Can Shop For',           'loan_costs'],
    ['E', 'Taxes and Other Government Fees',     'other_costs'],
    ['F', 'Prepaids',                            'other_costs'],
    ['G', 'Initial Escrow Payment at Closing',   'other_costs'],
    ['H', 'Other',                                'other_costs'],
  ];

  function drawLEPage2(ctx, data) {
    var x = MARGIN;
    var y = MARGIN;
    var w = CONTENT_W;

    // ── Header ──
    drawText(ctx, 'Closing Cost Details', x, y, { size: SZ_TITLE - 2, bold: true });
    y += SZ_TITLE + 4;
    drawHLine(ctx, x, x + w, y, { thickness: 1.25 });
    y += 8;

    // Two columns: Loan Costs (left) and Other Costs (right).
    var halfW = (w - 12) / 2;
    var leftX = x;
    var rightX = x + halfW + 12;
    var leftY = y;
    var rightY = y;

    var fees = data.fees || [];
    var bySection = {};
    for (var i = 0; i < fees.length; i++) {
      var f = fees[i];
      if (!bySection[f.section]) bySection[f.section] = [];
      bySection[f.section].push(f);
    }

    var totals = { loan_costs: 0, other_costs: 0, sections: {} };

    // Loan Costs header
    leftY = drawSectionBar(ctx, leftX, leftY, halfW, 'Loan Costs');

    // Other Costs header
    rightY = drawSectionBar(ctx, rightX, rightY, halfW, 'Other Costs');

    // Sections A, B, C → left column. Sections E, F, G, H → right column.
    for (var s = 0; s < FEE_SECTIONS.length; s++) {
      var sec = FEE_SECTIONS[s];
      var letter = sec[0], name = sec[1], side = sec[2];
      var rows = bySection[letter] || [];
      var total = 0;
      for (var j = 0; j < rows.length; j++) total += feeTotalCents(rows[j]);
      totals.sections[letter] = total;
      totals[side] += total;

      if (side === 'loan_costs') {
        leftY = drawFeeSection(ctx, leftX, leftY, halfW, letter, name, rows, total);
      } else {
        rightY = drawFeeSection(ctx, rightX, rightY, halfW, letter, name, rows, total);
      }
    }

    // Section D — Total Loan Costs (sum of A+B+C). Always appears at end of
    // left column, with a heavier divider above.
    drawHLine(ctx, leftX, leftX + halfW, leftY, { thickness: 0.75 });
    leftY += 4;
    drawText(ctx, 'D. TOTAL LOAN COSTS (A + B + C)', leftX + 4, leftY,
      { size: SZ_SMALL, bold: true });
    drawTextRight(ctx, moneyExact(totals.loan_costs), leftX + halfW - 4, leftY,
      { size: SZ_SMALL, bold: true });
    leftY += 14;
    drawHLine(ctx, leftX, leftX + halfW, leftY, { thickness: 0.75 });
    leftY += 8;

    // Section I — Total Other Costs (E+F+G+H).
    drawHLine(ctx, rightX, rightX + halfW, rightY, { thickness: 0.75 });
    rightY += 4;
    drawText(ctx, 'I. TOTAL OTHER COSTS (E + F + G + H)', rightX + 4, rightY,
      { size: SZ_SMALL, bold: true });
    drawTextRight(ctx, moneyExact(totals.other_costs), rightX + halfW - 4, rightY,
      { size: SZ_SMALL, bold: true });
    rightY += 14;
    drawHLine(ctx, rightX, rightX + halfW, rightY, { thickness: 0.75 });
    rightY += 14;

    // J. Total Closing Costs (D+I) — under right column, full-width row.
    var maxColY = Math.max(leftY, rightY) + 4;
    drawText(ctx, 'J. TOTAL CLOSING COSTS', rightX + 4, maxColY,
      { size: SZ_SMALL, bold: true });
    drawText(ctx, 'D + I', rightX + 4, maxColY + SZ_SMALL + 2, { size: SZ_FOOT });
    drawTextRight(ctx, moneyExact(totals.loan_costs + totals.other_costs), rightX + halfW - 4, maxColY,
      { size: SZ_SMALL, bold: true });
    drawText(ctx, 'Lender Credits', rightX + 4, maxColY + 24, { size: SZ_SMALL });
    drawTextRight(ctx, '$0.00', rightX + halfW - 4, maxColY + 24, { size: SZ_SMALL });
    maxColY += 38;

    // ── Calculating Cash to Close (full width below) ──
    if (maxColY + 130 > PAGE_H - MARGIN - 30) {
      // Out of space; skip this section — it'll be on page 3 if needed.
    } else {
      maxColY = drawSectionBar(ctx, x, maxColY, w, 'Calculating Cash to Close');
      var totalClosing = totals.loan_costs + totals.other_costs;
      var loanAmt = Number(data.loan_amount_cents) || 0;
      var salePrice = Number(data.purchase_price_cents) || 0;
      var downPayment = salePrice - loanAmt;
      var cashToClose = totalClosing + downPayment;

      // downPayment and cashToClose are already in cents; pass them straight
      // to moneyExact (which divides by 100 internally).
      var rowsCcl = [
        ['Total Closing Costs (J)',                            moneyExact(totalClosing)],
        ['Closing Costs Financed (Paid from your Loan Amount)', '$0.00'],
        ['Down Payment / Funds from Borrower',                  moneyExact(downPayment)],
        ['Deposit',                                             '$0.00'],
        ['Funds for Borrower',                                  '$0.00'],
        ['Seller Credits',                                      '$0.00'],
        ['Adjustments and Other Credits',                       '$0.00'],
      ];
      var rowH = 12;
      for (var r = 0; r < rowsCcl.length; r++) {
        drawText(ctx, rowsCcl[r][0], x + 4, maxColY + 4 + r * rowH, { size: SZ_BODY });
        drawTextRight(ctx, rowsCcl[r][1], x + w - 4, maxColY + 4 + r * rowH, { size: SZ_BODY });
      }
      maxColY += rowsCcl.length * rowH + 6;
      drawHLine(ctx, x, x + w, maxColY);
      maxColY += 4;
      drawText(ctx, 'Estimated Cash to Close', x + 4, maxColY, { size: SZ_SMALL, bold: true });
      drawTextRight(ctx, moneyExact(cashToClose), x + w - 4, maxColY,
        { size: SZ_SMALL, bold: true });
    }

    drawPageFooter(ctx, data, 2, 3);
  }

  // Render one fee section (A, B, C, E, F, G, or H). Returns next topY.
  function drawFeeSection(ctx, x, topY, w, letter, name, rows, total) {
    drawText(ctx, letter + '. ' + name, x + 4, topY + 4, { size: SZ_SMALL, bold: true });
    drawTextRight(ctx, moneyExact(total), x + w - 4, topY + 4, { size: SZ_SMALL, bold: true });
    var y = topY + 18;

    if (rows.length === 0) {
      drawText(ctx, '— no items —', x + 8, y, {
        size: SZ_SMALL,
        color: ctx.lib.rgb(0.55, 0.55, 0.55),
      });
      return y + 14;
    }

    // Collapse to up to 8 visible rows; if more, show "+ N more" line so the
    // page doesn't overflow. Demo loans typically have 3-6 fees per section.
    var maxRows = 8;
    var visible = rows.slice(0, maxRows);
    var hidden = rows.length - visible.length;

    var rowMaxLabelW = w - 80;   // leaves ~70pt for the dollar column
    for (var i = 0; i < visible.length; i++) {
      var f = visible[i];
      var label = String(f.description || '');
      // Truncate too-long descriptions
      if (ctx.fontReg.widthOfTextAtSize(label, SZ_SMALL) > rowMaxLabelW) {
        while (label.length > 4 &&
               ctx.fontReg.widthOfTextAtSize(label + '…', SZ_SMALL) > rowMaxLabelW) {
          label = label.slice(0, -1);
        }
        label = label + '…';
      }
      drawText(ctx, label, x + 8, y, { size: SZ_SMALL });
      drawTextRight(ctx, moneyExact(feeTotalCents(f)), x + w - 4, y, { size: SZ_SMALL });
      y += 11;
    }
    if (hidden > 0) {
      drawText(ctx, '+ ' + hidden + ' more line item' + (hidden === 1 ? '' : 's') + ' on file',
        x + 8, y, { size: SZ_FOOT, color: ctx.lib.rgb(0.5, 0.5, 0.5) });
      y += 10;
    }
    return y + 4;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LOAN ESTIMATE — page 3 of 3 · Comparisons, Other Considerations, Sign
  // ═════════════════════════════════════════════════════════════════════════
  function drawLEPage3(ctx, data) {
    var x = MARGIN;
    var y = MARGIN;
    var w = CONTENT_W;

    // Header
    drawText(ctx, 'Additional Information About This Loan', x, y, { size: SZ_TITLE - 2, bold: true });
    y += SZ_TITLE + 4;
    drawHLine(ctx, x, x + w, y, { thickness: 1.25 });
    y += 8;

    // ── LENDER / BROKER / LO BLOCK ──
    var infoBoxH = 80;
    drawBox(ctx, x, y, w, infoBoxH);
    var halfW = w / 2;
    var b = data.branch || {};
    var ba = b.address || {};

    drawText(ctx, 'LENDER', x + 6, y + 6, { size: SZ_LABEL, bold: true });
    drawText(ctx, b.name || '—', x + 6, y + 16, { size: SZ_BODY });
    drawText(ctx, fullAddressOneLine(ba), x + 6, y + 28, { size: SZ_SMALL });
    drawText(ctx, 'NMLS / __ License ID', x + 6, y + 42, { size: SZ_LABEL, bold: true });
    drawText(ctx, (b.nmls_id || '—') + ' / ' + (b.license_number || '—'),
      x + 6, y + 52, { size: SZ_BODY });

    var loBor = (data.borrowers && data.borrowers[0] && data.borrowers[0].loan_officer) || data.lo;
    drawText(ctx, 'LOAN OFFICER', x + halfW + 6, y + 6, { size: SZ_LABEL, bold: true });
    drawText(ctx, loBor && loBor.full_name || '—', x + halfW + 6, y + 16, { size: SZ_BODY });
    drawText(ctx, 'NMLS ID', x + halfW + 6, y + 28, { size: SZ_LABEL, bold: true });
    drawText(ctx, (loBor && loBor.nmls_id) || '—', x + halfW + 6, y + 38, { size: SZ_BODY });
    drawText(ctx, 'EMAIL', x + halfW + 6, y + 50, { size: SZ_LABEL, bold: true });
    drawText(ctx, (loBor && loBor.email) || '—', x + halfW + 6, y + 60, { size: SZ_BODY });

    y += infoBoxH + 12;

    // ── COMPARISONS ──
    y = drawSectionBar(ctx, x, y, w, 'Comparisons');
    drawText(ctx, 'Use these measures to compare this loan with other loans.',
      x + 6, y + 6, { size: SZ_FOOT });
    y += 22;

    var fees = data.fees || [];
    var totalClosing = fees.reduce(function (s, f) { return s + feeTotalCents(f); }, 0);
    var loanAmt = Number(data.loan_amount_cents) || 0;
    var monthlyPI = (data.pricing && data.pricing.monthly_pi_cents)
      || computeMonthlyPI(loanAmt, data.rate_bps, data.term_months) || 0;
    var fiveYearPayments = monthlyPI * 60;
    var fiveYearPrincipal = estimatePrincipalPaidIn5Years(loanAmt, data.rate_bps, data.term_months);

    // 5-year totals box
    var compBoxH = 70;
    drawBox(ctx, x, y, w, compBoxH);
    drawText(ctx, 'In 5 Years', x + 6, y + 6, { size: SZ_BODY, bold: true });
    drawText(ctx, moneyWhole(fiveYearPayments + totalClosing), x + 6, y + 22,
      { size: SZ_TITLE - 4, bold: true });
    drawText(ctx, 'Total you will have paid in principal,', x + 6, y + 44, { size: SZ_FOOT });
    drawText(ctx, 'interest, mortgage insurance, and loan costs.', x + 6, y + 53, { size: SZ_FOOT });

    drawText(ctx, moneyWhole(fiveYearPrincipal), x + halfW + 6, y + 22,
      { size: SZ_TITLE - 4, bold: true });
    drawText(ctx, 'Principal you will have paid off.', x + halfW + 6, y + 44, { size: SZ_FOOT });

    y += compBoxH + 10;

    // APR / TIP placeholders — production needs the real Reg Z calculation
    var aprApprox = data.rate_bps != null
      ? ((Number(data.rate_bps) + 25) / 100).toFixed(3) + '%'
      : '—';
    drawText(ctx, 'Annual Percentage Rate (APR)', x + 6, y, { size: SZ_BODY, bold: true });
    drawTextRight(ctx, aprApprox, x + halfW - 4, y, { size: SZ_BODY, bold: true });
    drawText(ctx, 'Your costs over the loan term expressed as a rate.', x + 6, y + 12, { size: SZ_FOOT });
    drawText(ctx, 'This is not your interest rate.', x + 6, y + 22, { size: SZ_FOOT });

    drawText(ctx, 'Total Interest Percentage (TIP)', x + halfW + 6, y, { size: SZ_BODY, bold: true });
    var tipApprox = (data.rate_bps != null && data.term_months)
      ? Math.round(((Number(data.rate_bps) / 100) * (Number(data.term_months) / 12)) * 0.55) + '.000%'
      : '—';
    drawTextRight(ctx, tipApprox, x + w - 4, y, { size: SZ_BODY, bold: true });
    drawText(ctx, 'Total amount of interest you will pay over the loan term', x + halfW + 6, y + 12, { size: SZ_FOOT });
    drawText(ctx, 'as a percentage of your loan amount.', x + halfW + 6, y + 22, { size: SZ_FOOT });
    y += 38;

    // ── OTHER CONSIDERATIONS ──
    y = drawSectionBar(ctx, x, y, w, 'Other Considerations');
    var oc = [
      ['Appraisal',
        'We may order an appraisal to determine the property\u2019s value and charge you for this appraisal. We will promptly give you a copy of any appraisal, even if your loan does not close. You can pay for an additional appraisal for your own use at your own cost.'],
      ['Assumption',
        'If you sell or transfer this property to another person, we will not allow assumption of this loan on the original terms.'],
      ['Homeowner\u2019s Insurance',
        'This loan requires homeowner\u2019s insurance on the property, which you may obtain from a company of your choice that we find acceptable.'],
      ['Late Payment',
        'If your payment is more than 15 days late, we will charge a late fee of 5% of the monthly principal and interest payment.'],
      ['Servicing',
        'We intend to service your loan. If so, you will make your payments to us.'],
    ];
    var ocLeading = SZ_FOOT + 1.5;
    for (var i = 0; i < oc.length; i++) {
      drawText(ctx, oc[i][0], x + 6, y, { size: SZ_SMALL, bold: true });
      var endY = drawWrapped(ctx, oc[i][1], x + 90, y, w - 100,
        { size: SZ_FOOT, leading: ocLeading });
      y = Math.max(y + 12, endY) + 4;
    }

    y += 8;
    drawHLine(ctx, x, x + w, y);
    y += 8;

    // ── CONFIRM RECEIPT (signature lines) ──
    drawText(ctx, 'Confirm Receipt', x, y, { size: SZ_SECTION, bold: true });
    y += SZ_SECTION + 6;
    drawWrapped(ctx,
      'By signing, you are only confirming that you have received this form. You do not have to accept this loan because you have signed or received this form.',
      x, y, w, { size: SZ_FOOT, leading: SZ_FOOT + 1.5 });
    y += 26;

    // Two signature blocks side by side
    var sigW = (w - 20) / 2;
    drawHLine(ctx, x, x + sigW, y);
    drawText(ctx, 'Applicant Signature', x, y + 4, { size: SZ_FOOT });
    drawTextRight(ctx, 'Date', x + sigW, y + 4, { size: SZ_FOOT });
    drawHLine(ctx, x + sigW + 20, x + w, y);
    drawText(ctx, 'Co-Applicant Signature', x + sigW + 20, y + 4, { size: SZ_FOOT });
    drawTextRight(ctx, 'Date', x + w, y + 4, { size: SZ_FOOT });

    drawPageFooter(ctx, data, 3, 3);
  }

  // Approximate the principal portion paid in the first 60 months.
  // Standard amortization formula. Returns cents.
  function estimatePrincipalPaidIn5Years(loanAmountCents, rateBps, termMonths) {
    if (!loanAmountCents || rateBps == null || !termMonths) return 0;
    var P = Number(loanAmountCents) / 100;
    var r = (Number(rateBps) / 10000) / 12;
    var n = Number(termMonths);
    if (r === 0) {
      var monthlyPrin = P / n;
      return Math.round(monthlyPrin * 60 * 100);
    }
    var pi = (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    var balance = P;
    for (var i = 0; i < 60 && i < n; i++) {
      var interestPart = balance * r;
      var principalPart = pi - interestPart;
      balance -= principalPart;
    }
    return Math.round((P - balance) * 100);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // INTENT TO PROCEED (single page)
  //
  // CFPB doesn't publish a model form for ITP — it's a lender-drafted
  // document confirming the borrower has received the LE and wishes to
  // proceed. Required before non-refundable fees (other than credit
  // report) can be collected (12 CFR § 1026.19(e)(2)(i)(A)).
  // ═════════════════════════════════════════════════════════════════════════
  function drawIntentPage(ctx, data) {
    var x = MARGIN;
    var y = MARGIN;
    var w = CONTENT_W;

    drawText(ctx, 'Intent to Proceed', x, y, { size: SZ_TITLE, bold: true });
    y += SZ_TITLE + 6;
    drawHLine(ctx, x, x + w, y, { thickness: 1.5 });
    y += 14;

    // Top fact box
    var topH = 80;
    drawBox(ctx, x, y, w, topH);
    var halfW = w / 2;
    var ty = y + 6;
    drawLabelValue(ctx, x + 8, ty, halfW - 16, 'LOAN ID #', data.loan_number || '—');
    drawLabelValue(ctx, x + 8, ty + 28, halfW - 16, 'PROPERTY',
      fullAddressOneLine(data.property_address));
    drawLabelValue(ctx, x + halfW + 8, ty, halfW - 16, 'LOAN AMOUNT',
      moneyWhole(data.loan_amount_cents));
    drawLabelValue(ctx, x + halfW + 8, ty + 28, halfW - 16, 'INTEREST RATE',
      rate(data.rate_bps) + ' · ' + term(data.term_months));
    y += topH + 14;

    drawText(ctx, 'Acknowledgment & Intent', x, y, { size: SZ_SECTION, bold: true });
    y += SZ_SECTION + 6;

    var body =
      'I/We acknowledge that I/we have received the Loan Estimate dated ' +
      fmtDate(data.le_sent_at || new Date().toISOString()) +
      ' for the loan referenced above. I/We confirm that I/we wish to proceed with the loan application as described in the Loan Estimate.' +
      '\n\n' +
      'I/We understand that:' +
      '\n  \u2022  The Loan Estimate is not an approval or denial of credit.' +
      '\n  \u2022  Final terms may vary based on third-party services, appraisal results, underwriting, and changes that I/we authorize.' +
      '\n  \u2022  By providing this intent to proceed, I/we authorize the lender to begin processing my/our application and to incur reasonable third-party fees on my/our behalf, including (but not limited to) appraisal and credit-report fees.' +
      '\n  \u2022  I/We are not obligated to accept this loan and may withdraw the application at any time.';

    var lines = body.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) {
        y += 6;
        continue;
      }
      // Indent bulleted lines
      var indent = line.startsWith('  \u2022') ? 16 : 0;
      y = drawWrapped(ctx, line.replace(/^\s+/, ''), x + indent, y, w - indent,
        { size: SZ_BODY, leading: SZ_BODY + 4 }) + 2;
    }

    y += 12;
    drawHLine(ctx, x, x + w, y);
    y += 14;

    // Signature blocks — one per borrower
    var bs = (data.borrowers || []).filter(Boolean);
    if (bs.length === 0) bs = [{}];   // at least one signature line if no borrowers

    var sigBlockH = 58;
    for (var b = 0; b < bs.length; b++) {
      drawText(ctx, 'BORROWER ' + (b + 1) + (bs[b].first_name ? ' · ' + fullName(bs[b]) : ''),
        x, y, { size: SZ_LABEL, bold: true });
      y += 14;
      drawHLine(ctx, x, x + w * 0.6, y + 18);
      drawText(ctx, 'Signature', x, y + 22, { size: SZ_FOOT });
      drawHLine(ctx, x + w * 0.6 + 12, x + w, y + 18);
      drawText(ctx, 'Date', x + w * 0.6 + 12, y + 22, { size: SZ_FOOT });
      y += 38;
    }

    drawPageFooter(ctx, data, 1, 1, 'INTENT TO PROCEED');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PUBLIC API — generators
  // ═════════════════════════════════════════════════════════════════════════
  async function generateLoanEstimate(data) {
    if (!data) throw new Error('generateLoanEstimate: loanData is required');
    var lib = await loadPdfLib();
    var doc = await lib.PDFDocument.create();
    doc.setTitle('Loan Estimate · ' + (data.loan_number || ''));
    doc.setAuthor((data.branch && data.branch.name) || 'OriginFlow LOS');
    doc.setProducer('OriginFlow LOS · disclosure-pdf.js');
    doc.setCreator('OriginFlow LOS');
    doc.setCreationDate(new Date());

    var fonts = {
      reg: await doc.embedFont(lib.StandardFonts.Helvetica),
      bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    };

    var p1 = doc.addPage([PAGE_W, PAGE_H]);
    drawLEPage1(makeCtx(p1, fonts, lib), data);

    var p2 = doc.addPage([PAGE_W, PAGE_H]);
    drawLEPage2(makeCtx(p2, fonts, lib), data);

    var p3 = doc.addPage([PAGE_W, PAGE_H]);
    drawLEPage3(makeCtx(p3, fonts, lib), data);

    return await doc.save();
  }

  async function generateIntentToProceed(data) {
    if (!data) throw new Error('generateIntentToProceed: loanData is required');
    var lib = await loadPdfLib();
    var doc = await lib.PDFDocument.create();
    doc.setTitle('Intent to Proceed · ' + (data.loan_number || ''));
    doc.setAuthor((data.branch && data.branch.name) || 'OriginFlow LOS');
    doc.setProducer('OriginFlow LOS · disclosure-pdf.js');
    doc.setCreator('OriginFlow LOS');
    doc.setCreationDate(new Date());

    var fonts = {
      reg: await doc.embedFont(lib.StandardFonts.Helvetica),
      bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    };

    var p = doc.addPage([PAGE_W, PAGE_H]);
    drawIntentPage(makeCtx(p, fonts, lib), data);

    return await doc.save();
  }

  // Combine LE + Intent into one PDF — the canonical "initial disclosure
  // package" sent to borrowers via eSign. Order matches what the borrower
  // expects to read: LE first (the actual estimate), Intent last (the
  // confirmation they sign).
  async function generateInitialDisclosurePackage(data) {
    if (!data) throw new Error('generateInitialDisclosurePackage: loanData is required');
    var lib = await loadPdfLib();
    var combined = await lib.PDFDocument.create();
    combined.setTitle('Initial Disclosures · ' + (data.loan_number || ''));
    combined.setAuthor((data.branch && data.branch.name) || 'OriginFlow LOS');
    combined.setProducer('OriginFlow LOS · disclosure-pdf.js');
    combined.setCreator('OriginFlow LOS');
    combined.setCreationDate(new Date());

    // Generate each component, then merge pages into the combined doc.
    var leBytes = await generateLoanEstimate(data);
    var itpBytes = await generateIntentToProceed(data);
    var leDoc = await lib.PDFDocument.load(leBytes);
    var itpDoc = await lib.PDFDocument.load(itpBytes);

    var lePages = await combined.copyPages(leDoc, leDoc.getPageIndices());
    for (var i = 0; i < lePages.length; i++) combined.addPage(lePages[i]);

    var itpPages = await combined.copyPages(itpDoc, itpDoc.getPageIndices());
    for (var j = 0; j < itpPages.length; j++) combined.addPage(itpPages[j]);

    return await combined.save();
  }

  // Helper: trigger a browser download of generated bytes. Convenience
  // export for testing in dev — production callers (e.g. eSign hook) will
  // pipe the Uint8Array straight to an upload instead.
  function downloadBytes(bytes, filename) {
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'disclosure.pdf';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 250);
  }

  // ─── EXPORT ──────────────────────────────────────────────────────────────
  window.OFDisclosure = {
    generateLoanEstimate: generateLoanEstimate,
    generateIntentToProceed: generateIntentToProceed,
    generateInitialDisclosurePackage: generateInitialDisclosurePackage,
    // Internal helpers exposed for unit tests / dev console:
    _downloadBytes: downloadBytes,
    _computeMonthlyPI: computeMonthlyPI,
    _feeTotalCents: feeTotalCents,
  };
})();
