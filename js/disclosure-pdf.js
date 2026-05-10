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
//   OFDisclosure.generateLoanEstimate(loanData)        - LE (3 pages, CFPB H-24)
//   OFDisclosure.generateIntentToProceed(loanData)
//   OFDisclosure.generateInitialDisclosurePackage(loanData)
//   OFDisclosure.generateClosingDisclosure(loanData)   - CD (5 pages, CFPB H-25)
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

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOSING DISCLOSURE (CFPB Form H-25) — Round 4-13
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Generates a 5-page Closing Disclosure approximating the CFPB H-25 form.
  // Compared to the LE, the CD:
  //   • Has seller-paid columns in the fee tables (purchase loans)
  //   • Shows "Calculating Cash to Close" comparison vs the LE
  //   • Has a full Summaries of Transaction ledger (both borrower + seller)
  //   • Computes real APR via Newton's method (not the LE's approximation)
  //   • Has Loan Calculations (Total of Payments, Finance Charge, Amount
  //     Financed, APR, TIP)
  //   • Has Contact Information for all parties
  //   • Has Confirm Receipt signature block
  //
  // What this v1 does NOT do:
  //   • AIR Table (Adjustable Interest Rate) — ARM loans are out of scope
  //   • AP Table (Adjustable Payment) — interest-only loans are out of scope
  //   • Pixel-perfect reproduction of CFPB H-25 (structurally correct +
  //     legible + has the right numbers — sufficient for demos and most
  //     fixed-rate originations; auditors get a recognizable form, not
  //     a regulatory facsimile)
  //
  // The closing-package edge function (next round) will call
  // generateClosingDisclosure(data) and dispatch the result via Dropbox
  // Sign with kind='cd'.

  // ─── APR via Newton-Raphson ──────────────────────────────────────────────
  // Standard mortgage APR formula:
  //   effective_amount = loan_amount - prepaid_finance_charges
  //   PV(monthly_pi, n, r) = monthly_pi * (1 - (1+r)^-n) / r
  //   Find r such that PV = effective_amount
  //
  // We iterate up to 50 times or until f(r) < $0.01. Returns rate in bps
  // (annualized). Falls back to the input rate_bps if non-convergence
  // (e.g., effective_amount is negative — implausible but defensive).

  function computeAprBps(loanAmountCents, rateBps, termMonths, financeChargesCents) {
    if (!loanAmountCents || loanAmountCents <= 0) return rateBps;
    if (!termMonths || termMonths <= 0) return rateBps;
    if (rateBps == null || rateBps < 0) return rateBps;

    // No finance charges → APR == note rate
    if (!financeChargesCents || financeChargesCents <= 0) return rateBps;

    var monthlyPi = computeMonthlyPI(loanAmountCents, rateBps, termMonths);
    if (!monthlyPi || monthlyPi <= 0) return rateBps;

    var effectiveAmount = loanAmountCents - financeChargesCents;
    if (effectiveAmount <= 0) return rateBps;   // implausible

    // Newton's method on f(r) = PV(monthly_pi, n, r) - effectiveAmount
    function pvFactor(r, n) {
      if (r === 0) return n;
      return (1 - Math.pow(1 + r, -n)) / r;
    }
    function f(r) { return monthlyPi * pvFactor(r, termMonths) - effectiveAmount; }

    var r = rateBps / 10000 / 12;     // start from monthly rate
    for (var i = 0; i < 50; i++) {
      var fv = f(r);
      if (Math.abs(fv) < 0.01) break;
      // Numerical derivative
      var dr = Math.max(r * 0.001, 1e-9);
      var dfdr = (f(r + dr) - fv) / dr;
      if (!isFinite(dfdr) || dfdr === 0) break;
      var rNext = r - fv / dfdr;
      // Safety bounds — annualized rate between 0% and 100%
      if (rNext < 0) rNext = 1e-6;
      if (rNext > 1.0 / 12) rNext = 1.0 / 12;
      if (Math.abs(rNext - r) < 1e-12) { r = rNext; break; }
      r = rNext;
    }
    return Math.round(r * 12 * 10000);     // back to annualized bps
  }

  // ─── TIP (Total Interest Percentage) ─────────────────────────────────────
  // TIP = (sum of all interest payments / loan amount) × 100, expressed
  // as a percentage with 3 decimals. For a fixed-rate loan, this is
  // (monthly_pi × n - loan_amount) / loan_amount × 100.

  function computeTipPct(loanAmountCents, rateBps, termMonths) {
    if (!loanAmountCents || loanAmountCents <= 0) return 0;
    var monthlyPi = computeMonthlyPI(loanAmountCents, rateBps, termMonths);
    if (!monthlyPi) return 0;
    var totalPayments = monthlyPi * termMonths;
    var totalInterest = totalPayments - loanAmountCents;
    return (totalInterest / loanAmountCents) * 100;
  }

  // ─── Finance charges = points + applicable fees ──────────────────────────
  // Per Reg Z, finance charges include points, origination, and certain
  // mandatory fees (mortgage insurance, prepaid interest, etc.) but NOT
  // appraisal, credit report, recording fees, or title insurance for the
  // OWNER's policy (lender's policy IS a finance charge).
  //
  // For v1 we approximate: section A (origination) + section F prepaid
  // interest + lender-paid mortgage insurance from F. This is a slight
  // overestimate vs strict Reg Z but close enough for ranking; the edge
  // function can refine when the closing package is finalized.

  function computeFinanceChargesCents(data) {
    var fees = data && data.fees ? data.fees : [];
    var charges = 0;
    for (var i = 0; i < fees.length; i++) {
      var f = fees[i];
      if (!f || f.archived_at) continue;
      // Section A is always a finance charge (origination, points)
      if (f.section === 'A') {
        charges += feeTotalCents(f);
      }
      // Selected items in F (prepaids) — match by description heuristic
      if (f.section === 'F' && f.description) {
        var desc = String(f.description).toLowerCase();
        if (desc.indexOf('prepaid interest') >= 0 ||
            desc.indexOf('per diem') >= 0 ||
            desc.indexOf('mortgage insurance') >= 0 ||
            desc.indexOf('mip') >= 0 ||
            desc.indexOf('upfront mi') >= 0) {
          charges += feeTotalCents(f);
        }
      }
    }
    return charges;
  }

  // ─── Bucket fees by section for the CD layout ────────────────────────────

  function bucketFeesBySection(fees) {
    var out = { A:[], B:[], C:[], E:[], F:[], G:[], H:[] };
    for (var i = 0; i < (fees || []).length; i++) {
      var f = fees[i];
      if (!f || f.archived_at) continue;
      if (out[f.section]) out[f.section].push(f);
    }
    return out;
  }

  function sumSection(rows) {
    var t = 0;
    for (var i = 0; i < rows.length; i++) t += feeTotalCents(rows[i]);
    return t;
  }

  // Borrower-at-closing only (used in summaries)
  function feeBorrowerAtClosing(f) {
    return Number(f.borrower_paid_at_closing_cents) || 0;
  }
  function feeBorrowerBefore(f) {
    return Number(f.borrower_paid_before_closing_cents) || 0;
  }
  function feeSellerAtClosing(f) {
    return Number(f.seller_paid_at_closing_cents) || 0;
  }
  function feeSellerBefore(f) {
    return Number(f.seller_paid_before_closing_cents) || 0;
  }
  function feePaidByOthers(f) {
    return Number(f.paid_by_others_cents) || 0;
  }

  // ─── CD helpers: settlement-type label, closing date formatting ──────────

  function settlementLabel(t) {
    return ({
      wet:               'Wet (signing & funding same day)',
      dry:               'Dry (signing; funding 1–3 days later)',
      table_funded:      'Table-funded',
      warehouse_funded:  'Warehouse-funded',
    })[t] || '—';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CD PAGE 1
  // ═══════════════════════════════════════════════════════════════════════════
  // CFPB Form H-25 page 1: header strip, transaction info (4-column), loan
  // information block, loan terms table, projected payments, costs at
  // closing, cash to close.

  function drawCDPage1(ctx, data) {
    var p = data.locked_pricing_scenario || {};
    var closing = data.closing || {};

    // Header
    drawText(ctx, 'Closing Disclosure', 36, 50, { font: ctx.fonts.bold, size: 18 });
    drawWrapped(ctx,
      'This form is a statement of final loan terms and closing costs. Compare this document with your Loan Estimate.',
      36, 78, PAGE_W - 72, { size: 9.5 });

    // Transaction info — 4 columns at top: Closing Information / Transaction Information / Loan Information / [empty]
    var topY = 110;
    drawSectionBar(ctx, 36, topY, PAGE_W - 72, '');
    var infoY = topY + 18;
    var colW = (PAGE_W - 72) / 3;

    // Column 1: Closing Information
    drawText(ctx, 'Closing Information', 40, infoY, { font: ctx.fonts.bold, size: 9 });
    drawLabelValue(ctx, 40, infoY + 16, colW - 8, 'Date Issued',
      fmtDate(closing.cd_sent_at || new Date().toISOString()), { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 30, colW - 8, 'Closing Date',
      fmtDate(closing.scheduled_at || closing.signed_at), { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 44, colW - 8, 'Disbursement Date',
      fmtDate(closing.disbursed_at || closing.funding_date || closing.scheduled_at), { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 58, colW - 8, 'Settlement Agent',
      closing.closing_agent_name || closing.title_company_name || '—', { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 72, colW - 8, 'File #',
      closing.title_file_number || '—', { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 86, colW - 8, 'Property',
      fullAddressOneLine(data.property_address) || '—', { size: 8.5 });
    drawLabelValue(ctx, 40, infoY + 100, colW - 8, 'Sale Price',
      data.purchase_price_cents ? moneyWhole(data.purchase_price_cents) : '—', { size: 8.5 });

    // Column 2: Transaction Information (parties)
    var col2x = 40 + colW;
    drawText(ctx, 'Transaction Information', col2x, infoY, { font: ctx.fonts.bold, size: 9 });
    var bs = (data.borrowers || []).slice(0, 2);
    drawLabelValue(ctx, col2x, infoY + 16, colW - 8, 'Borrower',
      bs.map(fullName).join('; ') || '—', { size: 8.5 });
    drawLabelValue(ctx, col2x, infoY + 30, colW - 8, 'Seller',
      data.seller_name || '— (refinance)', { size: 8.5 });
    drawLabelValue(ctx, col2x, infoY + 44, colW - 8, 'Lender',
      (data.branch && data.branch.name) || data.lender_name || 'OriginFlow Branch', { size: 8.5 });

    // Column 3: Loan Information
    var col3x = 40 + colW * 2;
    drawText(ctx, 'Loan Information', col3x, infoY, { font: ctx.fonts.bold, size: 9 });
    drawLabelValue(ctx, col3x, infoY + 16, colW - 8, 'Loan Term', term(data.term_months), { size: 8.5 });
    drawLabelValue(ctx, col3x, infoY + 30, colW - 8, 'Purpose', purposeLabel(data.purpose), { size: 8.5 });
    drawLabelValue(ctx, col3x, infoY + 44, colW - 8, 'Product',
      data.term_months ? Math.round(data.term_months / 12) + ' Year Fixed Rate' : '—', { size: 8.5 });
    drawLabelValue(ctx, col3x, infoY + 58, colW - 8, 'Loan Type', programLabel(data.program), { size: 8.5 });
    drawLabelValue(ctx, col3x, infoY + 72, colW - 8, 'Loan ID #', data.loan_number || '—', { size: 8.5 });
    drawLabelValue(ctx, col3x, infoY + 86, colW - 8, 'MIC #', '—', { size: 8.5 });

    // Loan Terms table
    var ltY = topY + 230;
    drawSectionBar(ctx, 36, ltY, PAGE_W - 72, 'Loan Terms');
    var rows = [
      ['Loan Amount',
        moneyWhole(p.loan_amount_cents || data.loan_amount_cents),
        'NO',
        'Can this amount increase after closing?'],
      ['Interest Rate',
        rate(p.rate_bps != null ? p.rate_bps : data.rate_bps),
        'NO',
        'Can this amount increase after closing?'],
      ['Monthly Principal & Interest',
        moneyExact(p.monthly_pi_cents || computeMonthlyPI(
          data.loan_amount_cents, data.rate_bps, data.term_months)),
        'NO',
        'Does the loan have these features?'],
      ['Prepayment Penalty', '—', 'NO', ''],
      ['Balloon Payment',    '—', 'NO', ''],
    ];
    var rY = ltY + 18;
    var rh = 28;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var bg = (i % 2 === 0) ? null : { color: { r: 0.96, g: 0.96, b: 0.96 } };
      if (bg) drawBox(ctx, 36, rY + i * rh, PAGE_W - 72, rh, bg);
      drawText(ctx, r[0], 40, rY + i * rh + 8, { font: ctx.fonts.bold, size: 9 });
      drawText(ctx, r[1], 200, rY + i * rh + 8, { size: 11 });
      drawText(ctx, r[2], 320, rY + i * rh + 8, { font: ctx.fonts.bold, size: 9 });
      if (r[3]) drawText(ctx, r[3], 360, rY + i * rh + 8, { size: 8.5, color: { r: 0.4, g: 0.4, b: 0.4 } });
    }

    // Projected Payments (single column; ARM/IO loans not supported in v1)
    var ppY = rY + rows.length * rh + 12;
    drawSectionBar(ctx, 36, ppY, PAGE_W - 72, 'Projected Payments');
    var ppHeaderY = ppY + 18;
    drawText(ctx, 'Payment Calculation',  40, ppHeaderY, { font: ctx.fonts.bold, size: 9 });
    drawText(ctx, 'Years 1 – ' + Math.round((data.term_months || 0) / 12), 220, ppHeaderY, { size: 9 });
    drawHLine(ctx, 36, PAGE_W - 36, ppHeaderY + 12);
    var pi = p.monthly_pi_cents || computeMonthlyPI(data.loan_amount_cents, data.rate_bps, data.term_months);
    var ppRows = [
      ['Principal & Interest', moneyExact(pi)],
      ['Mortgage Insurance', '+    —'],
      ['Estimated Escrow', '+    —'],
      ['Estimated Total Monthly Payment', moneyExact(pi)],
    ];
    for (var k = 0; k < ppRows.length; k++) {
      drawText(ctx, ppRows[k][0], 40, ppHeaderY + 24 + k * 16, {
        size: 9, font: k === 3 ? ctx.fonts.bold : ctx.fonts.reg,
      });
      drawTextRight(ctx, ppRows[k][1], 320, ppHeaderY + 24 + k * 16, {
        size: 9, font: k === 3 ? ctx.fonts.bold : ctx.fonts.reg,
      });
    }

    // Costs at Closing
    var ccY = ppHeaderY + 110;
    drawSectionBar(ctx, 36, ccY, PAGE_W - 72, 'Costs at Closing');
    var feesBucketed = bucketFeesBySection(data.fees);
    var totalLoanCosts = sumSection(feesBucketed.A) + sumSection(feesBucketed.B) + sumSection(feesBucketed.C);
    var totalOtherCosts = sumSection(feesBucketed.E) + sumSection(feesBucketed.F) +
                          sumSection(feesBucketed.G) + sumSection(feesBucketed.H);
    var totalClosingCosts = totalLoanCosts + totalOtherCosts;

    drawLabelValue(ctx, 40, ccY + 22, 240, 'Closing Costs', moneyWhole(totalClosingCosts), { size: 10, valueBold: true });
    drawText(ctx, 'Includes ' + moneyWhole(totalLoanCosts) + ' in Loan Costs + ' +
                  moneyWhole(totalOtherCosts) + ' in Other Costs.', 40, ccY + 42, { size: 8 });

    // Cash to Close — simplified for v1 (full ledger on page 3)
    var ctcEstimate = totalClosingCosts;     // rough; refined on page 3
    drawLabelValue(ctx, 320, ccY + 22, 240, 'Cash to Close',
      moneyWhole(ctcEstimate), { size: 10, valueBold: true });
    drawText(ctx, 'See Calculating Cash to Close on page 3 for details.', 320, ccY + 42, { size: 8 });

    drawPageFooter(ctx, data, 1, 5, 'CLOSING DISCLOSURE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CD PAGE 2 — Closing Cost Details (full fee itemization with seller-paid)
  // ═══════════════════════════════════════════════════════════════════════════

  function drawCDPage2(ctx, data) {
    drawText(ctx, 'Closing Cost Details', 36, 50, { font: ctx.fonts.bold, size: 14 });
    var fees = data.fees || [];
    var bucketed = bucketFeesBySection(fees);

    // Column header strip
    var hdrY = 80;
    drawHLine(ctx, 36, PAGE_W - 36, hdrY - 4);
    drawText(ctx, 'Loan Costs', 40, hdrY + 4, { font: ctx.fonts.bold, size: 10 });
    drawText(ctx, 'Borrower-Paid', 270, hdrY + 4, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'Seller-Paid', 380, hdrY + 4, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'Paid by',     480, hdrY + 4, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'At Closing', 270, hdrY + 16, { size: 7 });
    drawText(ctx, 'Before Closing', 320, hdrY + 16, { size: 7 });
    drawText(ctx, 'At Closing', 380, hdrY + 16, { size: 7 });
    drawText(ctx, 'Before Closing', 430, hdrY + 16, { size: 7 });
    drawText(ctx, 'Others', 480, hdrY + 16, { size: 7 });
    drawHLine(ctx, 36, PAGE_W - 36, hdrY + 28);

    var y = hdrY + 36;
    var sections = [
      { letter: 'A', name: 'Origination Charges' },
      { letter: 'B', name: 'Services Borrower Did Not Shop For' },
      { letter: 'C', name: 'Services Borrower Did Shop For' },
    ];

    var loanCostsTotal = 0;
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      var rows = bucketed[sec.letter] || [];
      var secTotal = sumSection(rows);
      loanCostsTotal += secTotal;
      // Section header bar
      drawText(ctx, sec.letter + '. ' + sec.name + ' (' + rows.length + ')', 40, y,
        { font: ctx.fonts.bold, size: 9 });
      drawTextRight(ctx, moneyExact(secTotal), 540, y, { font: ctx.fonts.bold, size: 9 });
      drawHLine(ctx, 36, PAGE_W - 36, y + 12, { color: { r: 0.85, g: 0.85, b: 0.85 } });
      y += 18;
      for (var i = 0; i < rows.length; i++) {
        if (y > PAGE_H - 80) break;
        var f = rows[i];
        drawText(ctx, '  ' + (i + 1) + '. ' + (f.description || ''), 40, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeBorrowerAtClosing(f)), 308, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeBorrowerBefore(f)),     368, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeSellerAtClosing(f)),    418, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeSellerBefore(f)),       468, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feePaidByOthers(f)),       518, y, { size: 8 });
        if (f.payee) {
          drawText(ctx, '  to ' + f.payee, 50, y + 10,
            { size: 7, color: { r: 0.4, g: 0.4, b: 0.4 } });
          y += 18;
        } else {
          y += 14;
        }
      }
      y += 6;
    }

    // D. Total Loan Costs subtotal
    drawHLine(ctx, 36, PAGE_W - 36, y);
    drawText(ctx, 'D.  TOTAL LOAN COSTS (Borrower-Paid)', 40, y + 4, { font: ctx.fonts.bold, size: 10 });
    drawTextRight(ctx, moneyExact(loanCostsTotal), 540, y + 4, { font: ctx.fonts.bold, size: 10 });
    y += 22;

    // Other Costs sections
    drawHLine(ctx, 36, PAGE_W - 36, y);
    drawText(ctx, 'Other Costs', 40, y + 4, { font: ctx.fonts.bold, size: 10 });
    y += 16;

    var otherSections = [
      { letter: 'E', name: 'Taxes and Other Government Fees' },
      { letter: 'F', name: 'Prepaids' },
      { letter: 'G', name: 'Initial Escrow Payment at Closing' },
      { letter: 'H', name: 'Other' },
    ];
    var otherCostsTotal = 0;
    for (var s2 = 0; s2 < otherSections.length; s2++) {
      var sec2 = otherSections[s2];
      var rows2 = bucketed[sec2.letter] || [];
      var secTotal2 = sumSection(rows2);
      otherCostsTotal += secTotal2;
      if (y > PAGE_H - 100) break;
      drawText(ctx, sec2.letter + '. ' + sec2.name + ' (' + rows2.length + ')', 40, y,
        { font: ctx.fonts.bold, size: 9 });
      drawTextRight(ctx, moneyExact(secTotal2), 540, y, { font: ctx.fonts.bold, size: 9 });
      drawHLine(ctx, 36, PAGE_W - 36, y + 12, { color: { r: 0.85, g: 0.85, b: 0.85 } });
      y += 18;
      for (var j = 0; j < rows2.length && y < PAGE_H - 80; j++) {
        var fj = rows2[j];
        drawText(ctx, '  ' + (j + 1) + '. ' + (fj.description || ''), 40, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeBorrowerAtClosing(fj)), 308, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeBorrowerBefore(fj)),     368, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeSellerAtClosing(fj)),    418, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feeSellerBefore(fj)),       468, y, { size: 8 });
        drawTextRight(ctx, moneyExact(feePaidByOthers(fj)),       518, y, { size: 8 });
        y += 14;
      }
      y += 6;
    }

    // I + J subtotals
    if (y < PAGE_H - 60) {
      drawHLine(ctx, 36, PAGE_W - 36, y);
      drawText(ctx, 'I.  TOTAL OTHER COSTS (Borrower-Paid)', 40, y + 4, { font: ctx.fonts.bold, size: 10 });
      drawTextRight(ctx, moneyExact(otherCostsTotal), 540, y + 4, { font: ctx.fonts.bold, size: 10 });
      y += 18;
      drawHLine(ctx, 36, PAGE_W - 36, y);
      drawText(ctx, 'J.  TOTAL CLOSING COSTS (Borrower-Paid)', 40, y + 4, { font: ctx.fonts.bold, size: 11 });
      drawTextRight(ctx, moneyExact(loanCostsTotal + otherCostsTotal), 540, y + 4,
        { font: ctx.fonts.bold, size: 11 });
    }

    drawPageFooter(ctx, data, 2, 5, 'CLOSING DISCLOSURE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CD PAGE 3 — Calculating Cash to Close + Summaries of Transaction
  // ═══════════════════════════════════════════════════════════════════════════

  function drawCDPage3(ctx, data) {
    drawText(ctx, 'Calculating Cash to Close', 36, 50, { font: ctx.fonts.bold, size: 14 });
    drawText(ctx, 'Use this table to see what has changed from your Loan Estimate.', 36, 70, { size: 9 });

    var fees = data.fees || [];
    var totalCC = 0, sellerAt = 0, sellerBefore = 0, others = 0;
    for (var i = 0; i < fees.length; i++) {
      var f = fees[i];
      if (f.archived_at) continue;
      totalCC      += feeBorrowerAtClosing(f) + feeBorrowerBefore(f);
      sellerAt     += feeSellerAtClosing(f);
      sellerBefore += feeSellerBefore(f);
      others       += feePaidByOthers(f);
    }

    // Approximate LE values (would come from the LE snapshot in a real impl).
    // For v1: pull le_amount_cents on each fee where present.
    var leTotal = 0;
    for (var j = 0; j < fees.length; j++) {
      if (fees[j].le_amount_cents != null) leTotal += Number(fees[j].le_amount_cents);
    }

    // Comparison table
    var ccY = 100;
    drawSectionBar(ctx, 36, ccY, PAGE_W - 72, 'Loan Estimate vs Final');
    var rows = [
      ['Total Closing Costs (J)', moneyWhole(leTotal), moneyWhole(totalCC),
       (totalCC === leTotal ? 'NO' : 'YES'),
       totalCC > leTotal ? 'See Total Loan Costs (D) and Total Other Costs (I)' : ''],
      ['Closing Costs Paid Before Closing', '$0', moneyWhole(0), 'NO', ''],
      ['Closing Costs Financed (Paid from your Loan Amount)', '$0', '$0', 'NO', ''],
      ['Down Payment / Funds from Borrower',
        moneyWhole(data.purchase_price_cents ? (data.purchase_price_cents - (data.loan_amount_cents || 0)) : 0),
        moneyWhole(data.purchase_price_cents ? (data.purchase_price_cents - (data.loan_amount_cents || 0)) : 0),
        'NO', ''],
      ['Deposit', '$0', '$0', 'NO', ''],
      ['Funds for Borrower', '$0', '$0', 'NO', ''],
      ['Seller Credits', '$0',
        '−' + moneyWhole(sellerAt + sellerBefore),
        sellerAt + sellerBefore > 0 ? 'YES' : 'NO', ''],
      ['Adjustments and Other Credits', '$0',
        '−' + moneyWhole(others),
        others > 0 ? 'YES' : 'NO', ''],
    ];
    var rY = ccY + 22;
    drawText(ctx, '',                  40, rY, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'Loan Estimate',    230, rY, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'Final',            315, rY, { font: ctx.fonts.bold, size: 8 });
    drawText(ctx, 'Did this change?', 380, rY, { font: ctx.fonts.bold, size: 8 });
    drawHLine(ctx, 36, PAGE_W - 36, rY + 12);
    rY += 20;

    for (var k = 0; k < rows.length; k++) {
      var rk = rows[k];
      var bg = (k % 2 === 0) ? null : { color: { r: 0.97, g: 0.97, b: 0.97 } };
      if (bg) drawBox(ctx, 36, rY, PAGE_W - 72, 22, bg);
      drawText(ctx, rk[0], 40, rY + 6, { size: 8 });
      drawTextRight(ctx, rk[1], 290, rY + 6, { size: 8 });
      drawTextRight(ctx, rk[2], 360, rY + 6, { size: 8 });
      drawText(ctx, rk[3], 410, rY + 6, { size: 8, font: ctx.fonts.bold });
      if (rk[4]) drawText(ctx, rk[4], 440, rY + 6, { size: 7, color: { r: 0.4, g: 0.4, b: 0.4 } });
      rY += 22;
    }
    drawHLine(ctx, 36, PAGE_W - 36, rY);

    // Cash to Close totals
    var downPayment = data.purchase_price_cents ? (data.purchase_price_cents - (data.loan_amount_cents || 0)) : 0;
    var cashToClose = totalCC + downPayment - (sellerAt + sellerBefore + others);
    drawText(ctx, 'Cash to Close', 40, rY + 8, { font: ctx.fonts.bold, size: 11 });
    drawTextRight(ctx, moneyWhole(leTotal + downPayment), 290, rY + 8, { font: ctx.fonts.bold, size: 10 });
    drawTextRight(ctx, moneyWhole(cashToClose),            360, rY + 8, { font: ctx.fonts.bold, size: 10 });

    // Summaries of Transaction — two-column ledger
    var stY = rY + 40;
    drawSectionBar(ctx, 36, stY, PAGE_W - 72, 'Summaries of Transaction');
    var col1x = 40, col2x = 320;
    drawText(ctx, "BORROWER'S TRANSACTION", col1x, stY + 22, { font: ctx.fonts.bold, size: 10 });
    drawText(ctx, "SELLER'S TRANSACTION",   col2x, stY + 22, { font: ctx.fonts.bold, size: 10 });

    var btY = stY + 40;
    drawText(ctx, 'K. Due from Borrower at Closing', col1x, btY, { font: ctx.fonts.bold, size: 9 });
    drawText(ctx, '  Sale Price', col1x, btY + 14, { size: 8.5 });
    drawTextRight(ctx, moneyWhole(data.purchase_price_cents || 0), col1x + 240, btY + 14, { size: 8.5 });
    drawText(ctx, '  Closing Costs (J)', col1x, btY + 28, { size: 8.5 });
    drawTextRight(ctx, moneyWhole(totalCC), col1x + 240, btY + 28, { size: 8.5 });

    drawText(ctx, 'L. Paid Already by or on Behalf of Borrower', col1x, btY + 60, { font: ctx.fonts.bold, size: 9 });
    drawText(ctx, '  Loan Amount', col1x, btY + 74, { size: 8.5 });
    drawTextRight(ctx, moneyWhole(data.loan_amount_cents || 0), col1x + 240, btY + 74, { size: 8.5 });
    drawText(ctx, '  Seller Credits', col1x, btY + 88, { size: 8.5 });
    drawTextRight(ctx, moneyWhole(sellerAt + sellerBefore), col1x + 240, btY + 88, { size: 8.5 });

    var ctcLine = (data.purchase_price_cents || 0) + totalCC - (data.loan_amount_cents || 0) - (sellerAt + sellerBefore);
    drawHLine(ctx, col1x, col1x + 260, btY + 110);
    drawText(ctx, 'CASH TO CLOSE  ' + (ctcLine >= 0 ? 'From' : 'To') + ' Borrower',
      col1x, btY + 120, { font: ctx.fonts.bold, size: 9 });
    drawTextRight(ctx, moneyWhole(Math.abs(ctcLine)), col1x + 240, btY + 120, { font: ctx.fonts.bold, size: 9 });

    // Seller column (skipped if no seller — refinance)
    if (data.purpose !== 'refi_no_cash' && data.purpose !== 'refi_cash_out') {
      drawText(ctx, 'M. Due to Seller at Closing', col2x, btY, { font: ctx.fonts.bold, size: 9 });
      drawText(ctx, '  Sale Price', col2x, btY + 14, { size: 8.5 });
      drawTextRight(ctx, moneyWhole(data.purchase_price_cents || 0), col2x + 240, btY + 14, { size: 8.5 });

      drawText(ctx, 'N. Due from Seller at Closing', col2x, btY + 50, { font: ctx.fonts.bold, size: 9 });
      drawText(ctx, '  Closing Costs Paid by Seller', col2x, btY + 64, { size: 8.5 });
      drawTextRight(ctx, moneyWhole(sellerAt + sellerBefore), col2x + 240, btY + 64, { size: 8.5 });

      var sellerNet = (data.purchase_price_cents || 0) - (sellerAt + sellerBefore);
      drawHLine(ctx, col2x, col2x + 260, btY + 110);
      drawText(ctx, 'CASH ' + (sellerNet >= 0 ? 'From' : 'To') + ' Seller', col2x, btY + 120,
        { font: ctx.fonts.bold, size: 9 });
      drawTextRight(ctx, moneyWhole(Math.abs(sellerNet)), col2x + 240, btY + 120, { font: ctx.fonts.bold, size: 9 });
    } else {
      drawText(ctx, '— Refinance: no seller side —', col2x, btY + 30, { size: 9, color: { r: 0.5, g: 0.5, b: 0.5 } });
    }

    drawPageFooter(ctx, data, 3, 5, 'CLOSING DISCLOSURE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CD PAGE 4 — Additional Information About This Loan
  // ═══════════════════════════════════════════════════════════════════════════

  function drawCDPage4(ctx, data) {
    drawText(ctx, 'Additional Information About This Loan', 36, 50,
      { font: ctx.fonts.bold, size: 14 });

    drawSectionBar(ctx, 36, 80, PAGE_W - 72, 'Loan Disclosures');
    var disclosures = [
      ['Assumption',
       'If you sell or transfer this property to another person, your lender'],
      ['',
       '☐  will allow, under certain conditions, this person to assume this loan on the original terms.'],
      ['',
       '☒  will not allow assumption of this loan on the original terms.'],
      ['Demand Feature',
       'Your loan'],
      ['',
       '☐  has a demand feature, which permits your lender to require early repayment of the loan.'],
      ['',
       '☒  does not have a demand feature.'],
      ['Late Payment',
       'If your payment is more than 15 days late, your lender will charge a late fee of 5% of the monthly principal & interest payment.'],
      ['Negative Amortization (Increase in Loan Amount)',
       'Under your loan terms, you'],
      ['',
       '☒  do not have a negative amortization feature.'],
      ['Partial Payments',
       'Your lender'],
      ['',
       '☒  may accept payments that are less than the full amount due (partial payments) and apply them to your loan.'],
      ['Security Interest',
       'You are granting a security interest in the property identified on page 1.'],
      ['',
       'You may lose this property if you do not make your payments or satisfy other obligations for this loan.'],
      ['Escrow Account',
       'For now, your loan'],
      ['',
       (data.has_escrow === false
         ? '☒  will not have an escrow account because you declined one.'
         : '☒  will have an escrow account (also called an "impound" or "trust" account) to pay the property costs listed below.')],
    ];
    var dy = 102;
    for (var i = 0; i < disclosures.length; i++) {
      if (dy > PAGE_H - 60) break;
      var d = disclosures[i];
      if (d[0]) drawText(ctx, d[0], 40, dy, { font: ctx.fonts.bold, size: 8.5 });
      drawWrapped(ctx, d[1], 200, dy, PAGE_W - 240, { size: 8.5 });
      // Wrapped lines: estimate height
      var lines = wrapText(d[1], ctx.fonts.reg, 8.5, PAGE_W - 240).length;
      dy += Math.max(14, lines * 11 + 2);
    }

    drawPageFooter(ctx, data, 4, 5, 'CLOSING DISCLOSURE');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CD PAGE 5 — Loan Calculations + Other Disclosures + Contacts + Signatures
  // ═══════════════════════════════════════════════════════════════════════════

  function drawCDPage5(ctx, data) {
    drawText(ctx, 'Loan Calculations', 36, 50, { font: ctx.fonts.bold, size: 14 });

    var p = data.locked_pricing_scenario || {};
    var rateBpsForCalc = p.rate_bps != null ? p.rate_bps : data.rate_bps;
    var monthlyPi = p.monthly_pi_cents || computeMonthlyPI(
      data.loan_amount_cents, rateBpsForCalc, data.term_months);
    var totalOfPayments = monthlyPi ? monthlyPi * data.term_months : 0;
    var financeCharges = computeFinanceChargesCents(data);
    var amountFinanced = (data.loan_amount_cents || 0) - financeCharges;
    var aprBps = computeAprBps(data.loan_amount_cents, rateBpsForCalc, data.term_months, financeCharges);
    var tipPct = computeTipPct(data.loan_amount_cents, rateBpsForCalc, data.term_months);

    // Four big-number boxes
    var calcs = [
      ['Total of Payments',
       moneyWhole(totalOfPayments),
       'Total you will have paid after you make all payments of principal, interest, mortgage insurance, and loan costs as scheduled.'],
      ['Finance Charge',
       moneyWhole(financeCharges + (totalOfPayments - (data.loan_amount_cents || 0))),
       'The dollar amount the loan will cost you.'],
      ['Amount Financed',
       moneyWhole(amountFinanced),
       'The loan amount available after paying your upfront finance charge.'],
      ['Annual Percentage Rate (APR)',
       (aprBps / 100).toFixed(3) + '%',
       'Your costs over the loan term expressed as a rate. This is not your interest rate.'],
      ['Total Interest Percentage (TIP)',
       tipPct.toFixed(3) + '%',
       'The total amount of interest that you will pay over the loan term as a percentage of your loan amount.'],
    ];
    var cY = 80;
    for (var i = 0; i < calcs.length; i++) {
      drawBox(ctx, 36, cY, PAGE_W - 72, 36, { borderColor: { r: 0.7, g: 0.7, b: 0.7 } });
      drawText(ctx, calcs[i][0], 44, cY + 8,  { font: ctx.fonts.bold, size: 9 });
      drawText(ctx, calcs[i][1], 44, cY + 22, { font: ctx.fonts.bold, size: 14 });
      drawWrapped(ctx, calcs[i][2], 240, cY + 8, PAGE_W - 290, { size: 8 });
      cY += 42;
    }

    // Other Disclosures — short version
    cY += 6;
    drawSectionBar(ctx, 36, cY, PAGE_W - 72, 'Other Disclosures');
    cY += 18;
    var od = [
      'Appraisal: If the property was appraised for your loan, your lender is required to give you a copy at no additional cost at least 3 days before closing. If you have not yet received it, please contact your lender at the information listed below.',
      'Contract Details: See your note and security instrument for information about what happens if you fail to make your payments, what is a default on the loan, situations in which your lender can require early repayment of the loan, and the rules for making payments before they are due.',
      'Liability after Foreclosure: State law may protect you from liability for any unpaid balance if your lender forecloses on your home. If you refinance or take on additional debt on this property, you may lose this protection.',
      'Refinance: Refinancing this loan will depend on your future financial situation, the property value, and market conditions. You may not be able to refinance this loan.',
      'Tax Deductions: If you borrow more than this property is worth, the interest on the loan amount above this property\u2019s fair market value is not deductible from your federal income taxes. You should consult a tax advisor for more information.',
    ];
    for (var k = 0; k < od.length && cY < PAGE_H - 200; k++) {
      drawWrapped(ctx, od[k], 40, cY, PAGE_W - 80, { size: 7.5 });
      cY += Math.max(20, wrapText(od[k], ctx.fonts.reg, 7.5, PAGE_W - 80).length * 10 + 4);
    }

    // Contact Information
    cY += 4;
    if (cY < PAGE_H - 140) {
      drawSectionBar(ctx, 36, cY, PAGE_W - 72, 'Contact Information');
      cY += 18;
      drawText(ctx, 'Lender', 40, cY, { font: ctx.fonts.bold, size: 9 });
      drawText(ctx, (data.branch && data.branch.name) || 'OriginFlow Branch', 100, cY, { size: 9 });
      cY += 14;
      if (data.lo_name) {
        drawText(ctx, 'Loan Officer', 40, cY, { font: ctx.fonts.bold, size: 9 });
        drawText(ctx, data.lo_name, 100, cY, { size: 9 });
        cY += 14;
      }
      if (data.closing && data.closing.title_company_name) {
        drawText(ctx, 'Settlement Agent', 40, cY, { font: ctx.fonts.bold, size: 9 });
        drawText(ctx, data.closing.title_company_name, 100, cY, { size: 9 });
        cY += 14;
      }
    }

    // Confirm Receipt block
    if (cY < PAGE_H - 80) {
      cY = PAGE_H - 80;
      drawText(ctx, 'Confirm Receipt', 36, cY, { font: ctx.fonts.bold, size: 11 });
      drawText(ctx,
        'By signing, you are only confirming that you have received this form. You do not have to accept this loan because you have signed or received this form.',
        36, cY + 16, { size: 8 });
      var bs = (data.borrowers || []).slice(0, 2);
      for (var b = 0; b < bs.length; b++) {
        var bx = 36 + b * 280;
        drawHLine(ctx, bx, bx + 240, cY + 50);
        drawText(ctx, fullName(bs[b]) + ' · Date',
          bx, cY + 56, { size: 8 });
      }
    }

    drawPageFooter(ctx, data, 5, 5, 'CLOSING DISCLOSURE');
  }

  // ─── ENTRY POINT ─────────────────────────────────────────────────────────

  async function generateClosingDisclosure(data) {
    if (!data) throw new Error('generateClosingDisclosure: loanData is required');
    var lib = await loadPdfLib();
    var doc = await lib.PDFDocument.create();
    doc.setTitle('Closing Disclosure · ' + (data.loan_number || ''));
    doc.setAuthor((data.branch && data.branch.name) || 'OriginFlow LOS');
    doc.setProducer('OriginFlow LOS · disclosure-pdf.js');
    doc.setCreator('OriginFlow LOS');
    doc.setCreationDate(new Date());

    var fonts = {
      reg:  await doc.embedFont(lib.StandardFonts.Helvetica),
      bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    };

    drawCDPage1(makeCtx(doc.addPage([PAGE_W, PAGE_H]), fonts, lib), data);
    drawCDPage2(makeCtx(doc.addPage([PAGE_W, PAGE_H]), fonts, lib), data);
    drawCDPage3(makeCtx(doc.addPage([PAGE_W, PAGE_H]), fonts, lib), data);
    drawCDPage4(makeCtx(doc.addPage([PAGE_W, PAGE_H]), fonts, lib), data);
    drawCDPage5(makeCtx(doc.addPage([PAGE_W, PAGE_H]), fonts, lib), data);

    return await doc.save();
  }

  // ─── EXPORT ──────────────────────────────────────────────────────────────
  window.OFDisclosure = {
    generateLoanEstimate: generateLoanEstimate,
    generateIntentToProceed: generateIntentToProceed,
    generateInitialDisclosurePackage: generateInitialDisclosurePackage,
    generateClosingDisclosure: generateClosingDisclosure,
    // Internal helpers exposed for unit tests / dev console:
    _downloadBytes: downloadBytes,
    _computeMonthlyPI: computeMonthlyPI,
    _feeTotalCents: feeTotalCents,
    _computeAprBps: computeAprBps,
    _computeTipPct: computeTipPct,
    _computeFinanceChargesCents: computeFinanceChargesCents,
  };
})();
