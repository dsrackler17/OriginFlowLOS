// ═══════════════════════════════════════════════════════════════════════════
// /js/mismo-generator.js
//
// OriginFlow LOS · Round 4 · MISMO 3.4 XML generator (AUS submission subset)
//
// Generates a MISMO v3.4.0 / ULAD-aligned XML envelope from the loan +
// borrowers + property data we already have in the database. The output is
// what gets POSTed to a real DU / LP / GUS integration, and what the
// run-aus edge function archives in aus_runs.request_xml for audit.
//
// What this is:
//   • Plain JS module, exposes window.OFMismo
//   • Pure function: input is a loanData object, output is XML string
//   • Covers DEAL with ASSETS, COLLATERALS, LIABILITIES, LOANS, PARTIES,
//     and RELATIONSHIPS — i.e., enough for a DU/LP/GUS submission to
//     parse and respond against.
//
// What this is NOT:
//   • A complete MISMO 3.4 implementation. The schema has thousands of
//     elements; we cover what AUS needs. URLA / iLAD / ULAD extensions
//     beyond the AUS path (e.g., CD-side ULDD) are out of scope.
//   • Schema-validated. We emit well-formed XML that aligns with MISMO
//     element ordering rules; validate against the Fannie Mae XSDs in
//     a future hardening pass.
//
// Spec references (all public):
//   MISMO 3.4 Reference Model:
//     https://www.mismo.org/standards-and-resources/residential
//   ULAD Mapping Document (URLA 1003 → MISMO 3.4):
//     https://www.fanniemae.com/singlefamily/uniform-loan-application-dataset
//
// Public API:
//   OFMismo.generateMISMO34(loanData)            → string  (XML)
//   OFMismo.prettyPrintXml(xml)                  → string  (formatted)
//   OFMismo.validateLoanDataShape(loanData)      → string[] (warnings)
//
// Missing fields don't break generation — they're omitted (with a
// validateLoanDataShape() warning so the caller knows the AUS may issue
// data-quality findings).
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── XML PRIMITIVES ──────────────────────────────────────────────────────
  // Hand-rolled because (a) no external deps and (b) MISMO has strict
  // element ordering inside containers; DOM APIs don't preserve insertion
  // order reliably across all engines.

  function escapeXml(s) {
    if (s == null) return '';
    return String(s).replace(/[<>&"']/g, function (c) {
      return ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c];
    });
  }

  // Render an element with optional attrs and either text content or
  // children (which are pre-rendered XML strings). Empty containers and
  // null/empty text are dropped — MISMO prefers omitted fields over empty
  // tags, and AUS engines treat empty tags as "data quality issue."
  function el(tag, opts) {
    var o = opts || {};
    var attrs = o.attrs || {};
    var text = o.text;
    var children = o.children || [];

    var attrStr = '';
    var hasAttrs = false;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] != null) {
        attrStr += ' ' + k + '="' + escapeXml(attrs[k]) + '"';
        hasAttrs = true;
      }
    }

    if (text != null && text !== '') {
      return '<' + tag + attrStr + '>' + escapeXml(text) + '</' + tag + '>';
    }

    var nonEmptyChildren = children.filter(function (c) {
      return c != null && c !== '' && c !== false;
    });
    if (nonEmptyChildren.length === 0) {
      // Empty content. If the element carries attributes (xlink relationships
      // are exactly this), render self-closing. Otherwise drop it — MISMO
      // prefers omitted fields over empty tags, and AUS engines treat empty
      // tags as data-quality issues.
      if (hasAttrs) return '<' + tag + attrStr + '/>';
      return '';
    }

    return '<' + tag + attrStr + '>' + nonEmptyChildren.join('') + '</' + tag + '>';
  }

  function txt(tag, value) {
    if (value == null || value === '') return '';
    return el(tag, { text: value });
  }

  // Pretty-printer for human inspection. Production XML is single-line
  // (smaller payload, faster to send). Use this for debugging.
  function prettyPrintXml(xml) {
    if (!xml) return '';
    var formatted = '';
    var depth = 0;
    var withBreaks = xml.replace(/></g, '>\n<');
    var lines = withBreaks.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('</') === 0) depth = Math.max(0, depth - 1);
      formatted += new Array(depth + 1).join('  ') + line + '\n';
      // Element opens depth iff it's an opening tag, not self-closing,
      // not a one-liner like <Foo>bar</Foo>.
      var isOpen = line.indexOf('<') === 0 &&
                   line.indexOf('</') !== 0 &&
                   line.indexOf('<?') !== 0 &&
                   line.indexOf('<!') !== 0 &&
                   line.lastIndexOf('/>') !== line.length - 2 &&
                   !/<([A-Za-z_][\w-]*)[^>]*>[^<]*<\/\1>/.test(line);
      if (isOpen) depth++;
    }
    return formatted;
  }

  // ─── VALUE FORMATTERS ────────────────────────────────────────────────────
  // MISMO uses specific formats: dollars to 2 decimals, rates to 3 decimals,
  // dates as YYYY-MM-DD, booleans as 'true'/'false' (lowercase).

  function fmtMoneyDollars(cents) {
    if (cents == null) return null;
    var n = Number(cents) / 100;
    if (!isFinite(n)) return null;
    return n.toFixed(2);
  }

  function fmtRatePercent(bps) {
    if (bps == null) return null;
    var n = Number(bps) / 100;
    if (!isFinite(n)) return null;
    return n.toFixed(3);
  }

  function fmtDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);   // YYYY-MM-DD
  }

  function fmtDateTime(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function fmtBool(v) {
    if (v == null) return null;
    return v ? 'true' : 'false';
  }

  function digitsOnly(s) {
    if (s == null) return null;
    var d = String(s).replace(/\D/g, '');
    return d || null;
  }

  // SSN format MISMO expects: 9 digits, no separators. If we only have
  // last4 (the OriginFlow default), we omit the field — emitting a
  // placeholder would produce a worse outcome (DU rejects + believes
  // the lender is misrepresenting data). validateLoanDataShape() flags
  // the omission so callers know.
  function formatSsnFull(b) {
    if (b && b.ssn) {
      var d = digitsOnly(b.ssn);
      if (d && d.length === 9) return d;
    }
    return null;
  }

  // ─── VALUE MAPS ──────────────────────────────────────────────────────────
  // OriginFlow uses lowercase / underscore-separated; MISMO uses
  // PascalCase enumerated values. Maps cover the common cases; unknown
  // values fall through to a sensible default rather than being dropped.

  var PROGRAM_TO_MORTGAGE_TYPE = {
    conv: 'Conventional', conventional: 'Conventional',
    fha: 'FHA',
    va: 'VA',
    usda: 'USDARural',
    jumbo: 'Conventional',
    non_qm: 'Conventional',
  };

  var LOAN_PURPOSE_MAP = {
    purchase: 'Purchase',
    refinance: 'Refinance',
    cashout_refinance: 'Refinance',
    construction: 'Other',
    renovation: 'Other',
  };

  var REFI_CASHOUT_MAP = {
    refinance: 'NoCashOut',
    cashout_refinance: 'CashOut',
  };

  var OCCUPANCY_MAP = {
    primary: 'PrimaryResidence', primary_residence: 'PrimaryResidence',
    second_home: 'SecondHome', secondary: 'SecondHome',
    investment: 'Investment', investor: 'Investment',
  };

  var PROPERTY_TYPE_MAP = {
    single_family: 'Detached', sfr: 'Detached', detached: 'Detached',
    condo: 'Condominium', condominium: 'Condominium',
    townhouse: 'Attached', attached: 'Attached',
    '2_unit': 'TwoUnit',
    '3_unit': 'ThreeUnit',
    '4_unit': 'FourUnit',
    manufactured: 'ManufacturedHome',
    pud: 'PUD',
  };

  var CITIZENSHIP_MAP = {
    us_citizen: 'USCitizen',
    permanent_resident: 'PermanentResidentAlien',
    non_permanent_resident: 'NonPermanentResidentAlien',
    non_resident: 'NonResidentAlien',
  };

  var MARITAL_STATUS_MAP = {
    married: 'Married',
    unmarried: 'Unmarried',
    separated: 'Separated',
  };

  // Liability types — MISMO's LiabilityType enum.
  var LIABILITY_TYPE_MAP = {
    revolving: 'Revolving',
    installment: 'Installment',
    mortgage: 'MortgageLoan',
    heloc: 'HELOC',
    open_30: 'Open30DayChargeAccount',
    lease: 'LeasePayments',
    student: 'Installment',
    auto: 'Installment',
    other: 'Other',
  };

  var ASSET_TYPE_MAP = {
    checking: 'CheckingAccount',
    savings: 'SavingsAccount',
    money_market: 'MoneyMarketFund',
    cd: 'CertificateOfDepositTimeDeposit',
    stocks: 'Stock',
    bonds: 'Bond',
    mutual_fund: 'MutualFund',
    retirement: 'RetirementFund',
    life_insurance: 'LifeInsurance',
    gift: 'GiftsCashTotal',
    other: 'OtherLiquidAsset',
  };

  // ─── ID HELPERS ──────────────────────────────────────────────────────────
  // MISMO uses xlink:label / xlink:from / xlink:to to wire entities
  // together. Centralized so the LOANS, PARTIES, COLLATERALS, and
  // RELATIONSHIPS sections all reference consistent IDs.

  function loanLabel()           { return 'Loan_001'; }
  function propertyLabel()       { return 'Property_001'; }
  function borrowerLabel(idx)    { return 'Party_Borrower_' + String(idx + 1).padStart(3, '0'); }
  function lenderLabel()         { return 'Party_Lender_001'; }
  function loanOfficerLabel()    { return 'Party_LO_001'; }
  function employerLabel(borIdx, empIdx) {
    return 'Party_Employer_' + String(borIdx + 1).padStart(2, '0') + '_' +
           String(empIdx + 1).padStart(2, '0');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SECTION BUILDERS
  // Each function returns an XML string (or '') for one section of the DEAL.
  // MISMO requires alphabetical ordering inside the DEAL container:
  //   ASSETS, COLLATERALS, EXPENSES, LIABILITIES, LOANS, PARTIES, RELATIONSHIPS
  // generateMISMO34() assembles them in that order.
  // ═════════════════════════════════════════════════════════════════════════

  // ─── ADDRESS ─────────────────────────────────────────────────────────────
  function buildAddress(addr) {
    if (!addr) return '';
    return el('ADDRESS', {
      children: [
        txt('AddressLineText', addr.street),
        txt('AddressUnitIdentifier', addr.unit),
        txt('CityName', addr.city),
        txt('CountryCode', addr.country || 'US'),
        txt('CountyName', addr.county),
        txt('PostalCode', addr.zip),
        txt('StateCode', addr.state ? String(addr.state).toUpperCase() : null),
      ],
    });
  }

  // ─── ASSETS ──────────────────────────────────────────────────────────────
  // Collected per borrower, but emitted as a flat ASSETS list with
  // RELATIONSHIPS linking each ASSET to its owner. We just emit the flat
  // list here; relationships are added in buildRelationships().
  function buildAssets(loanData) {
    var assetsXml = [];
    var idx = 1;

    (loanData.borrowers || []).forEach(function (b) {
      (b.assets || []).forEach(function (a) {
        var label = 'Asset_' + String(idx).padStart(3, '0');
        idx++;

        assetsXml.push(el('ASSET', {
          attrs: { 'xlink:label': label },
          children: [
            el('ASSET_DETAIL', {
              children: [
                txt('AssetType', ASSET_TYPE_MAP[a.type] || 'OtherLiquidAsset'),
                txt('AssetCashOrMarketValueAmount', fmtMoneyDollars(a.balance_cents)),
                txt('AssetAccountIdentifier', a.account_number_last4
                  ? '****' + a.account_number_last4 : null),
              ],
            }),
            // ASSET_HOLDER is the financial institution.
            a.institution_name ? el('ASSET_HOLDER', {
              children: [
                el('ASSET_HOLDER_NAME', {
                  children: [txt('FullName', a.institution_name)],
                }),
              ],
            }) : '',
          ],
        }));
      });
    });

    if (assetsXml.length === 0) return '';
    return el('ASSETS', { children: assetsXml });
  }

  // ─── COLLATERALS ─────────────────────────────────────────────────────────
  // Subject property only. Investor properties / second homes also go here
  // but we only have one subject property per loan.
  function buildCollaterals(loanData) {
    var addr = loanData.property_address || {};

    var subjectProperty = el('SUBJECT_PROPERTY', {
      attrs: { 'xlink:label': propertyLabel() },
      children: [
        buildAddress(addr),

        el('PROPERTY_DETAIL', {
          children: [
            txt('PropertyEstateType', 'FeeSimple'),
            txt('PropertyUsageType',
              OCCUPANCY_MAP[loanData.occupancy] || 'PrimaryResidence'),
            txt('FinancedUnitCount', unitCountFromPropertyType(loanData.property_type)),
            txt('AttachmentType',
              attachmentTypeFromPropertyType(loanData.property_type)),
            txt('ConstructionMethodType', 'SiteBuilt'),
          ],
        }),

        // Appraised value (if we have it).
        loanData.appraised_value_cents
          ? el('PROPERTY_VALUATIONS', {
              children: [
                el('PROPERTY_VALUATION', {
                  children: [
                    el('PROPERTY_VALUATION_DETAIL', {
                      children: [
                        txt('PropertyValuationAmount',
                          fmtMoneyDollars(loanData.appraised_value_cents)),
                        txt('PropertyValuationMethodType', 'FullAppraisal'),
                      ],
                    }),
                  ],
                }),
              ],
            })
          : '',

        // Sales contract (purchase only).
        loanData.purchase_price_cents && loanData.purpose === 'purchase'
          ? el('SALES_CONTRACTS', {
              children: [
                el('SALES_CONTRACT', {
                  children: [
                    el('SALES_CONTRACT_DETAIL', {
                      children: [
                        txt('RealPropertyAmount',
                          fmtMoneyDollars(loanData.purchase_price_cents)),
                      ],
                    }),
                  ],
                }),
              ],
            })
          : '',
      ],
    });

    return el('COLLATERALS', {
      children: [el('COLLATERAL', { children: [subjectProperty] })],
    });
  }

  function unitCountFromPropertyType(t) {
    var map = {
      single_family: 1, sfr: 1, detached: 1, condo: 1, townhouse: 1,
      pud: 1, manufactured: 1,
      '2_unit': 2, '3_unit': 3, '4_unit': 4,
    };
    return map[t] != null ? String(map[t]) : '1';
  }

  function attachmentTypeFromPropertyType(t) {
    if (!t) return 'Detached';
    if (t === 'condo' || t === 'townhouse' || t === 'attached') return 'Attached';
    return 'Detached';
  }

  // ─── LIABILITIES ─────────────────────────────────────────────────────────
  function buildLiabilities(loanData) {
    var liabsXml = [];
    var idx = 1;

    (loanData.borrowers || []).forEach(function (b) {
      (b.liabilities || []).forEach(function (l) {
        var label = 'Liability_' + String(idx).padStart(3, '0');
        idx++;

        liabsXml.push(el('LIABILITY', {
          attrs: { 'xlink:label': label },
          children: [
            el('LIABILITY_DETAIL', {
              children: [
                txt('LiabilityType', LIABILITY_TYPE_MAP[l.type] || 'Other'),
                txt('LiabilityUnpaidBalanceAmount', fmtMoneyDollars(l.balance_cents)),
                txt('LiabilityMonthlyPaymentAmount', fmtMoneyDollars(l.monthly_payment_cents)),
                txt('LiabilityRemainingTermMonthsCount',
                  l.remaining_term_months != null ? String(l.remaining_term_months) : null),
                txt('LiabilityAccountIdentifier', l.account_number_last4
                  ? '****' + l.account_number_last4 : null),
                txt('LiabilityExclusionIndicator', fmtBool(l.exclude_from_dti)),
                txt('LiabilityPayoffStatusIndicator', fmtBool(l.will_be_paid_off)),
              ],
            }),
            // LIABILITY_HOLDER (creditor name).
            l.creditor_name ? el('LIABILITY_HOLDER', {
              children: [
                el('LIABILITY_HOLDER_NAME', {
                  children: [txt('FullName', l.creditor_name)],
                }),
              ],
            }) : '',
          ],
        }));
      });
    });

    if (liabsXml.length === 0) return '';
    return el('LIABILITIES', { children: liabsXml });
  }

  // ─── LOANS ───────────────────────────────────────────────────────────────
  // The loan terms block. MISMO has a LOTS of optional fields here; we
  // populate the AUS-essentials.
  function buildLoans(loanData) {
    var loanAmt = fmtMoneyDollars(loanData.loan_amount_cents);
    var rate = fmtRatePercent(loanData.rate_bps);
    var purposeMisMo = LOAN_PURPOSE_MAP[loanData.purpose] || 'Purchase';

    // Compute monthly P&I if not provided. AUS expects this on the LOAN.
    var monthlyPI = loanData.pricing && loanData.pricing.monthly_pi_cents
      ? loanData.pricing.monthly_pi_cents
      : computeMonthlyPI(loanData.loan_amount_cents,
                         loanData.rate_bps,
                         loanData.term_months);

    // LTV and CLTV computed on the fly if not on loanData (they're on
    // the loans table but might not be in the payload).
    var ltvPct = loanData.ltv_pct;
    if (ltvPct == null && loanData.loan_amount_cents && loanData.appraised_value_cents) {
      ltvPct = (Number(loanData.loan_amount_cents) / Number(loanData.appraised_value_cents)) * 100;
    }

    var loan = el('LOAN', {
      attrs: { 'xlink:label': loanLabel(), LoanRoleType: 'SubjectLoan' },
      children: [
        // AMORTIZATION
        el('AMORTIZATION', {
          children: [
            el('AMORTIZATION_RULE', {
              children: [
                txt('AmortizationType', 'Fixed'),     // ARMs not yet modeled
                txt('LoanAmortizationPeriodCount',
                  loanData.term_months ? String(loanData.term_months) : null),
                txt('LoanAmortizationPeriodType', 'Month'),
              ],
            }),
          ],
        }),

        // CLOSING_INFORMATION (lock + intent dates if we have them)
        el('CLOSING_INFORMATION', {
          children: [
            el('CLOSING_INFORMATION_DETAIL', {
              children: [
                txt('LoanIdentifier', loanData.loan_number),
                txt('CashFromBorrowerAtClosingAmount',
                  computeCashToClose(loanData)),
              ],
            }),
          ],
        }),

        // DOCUMENT_SPECIFIC_DATA_SETS — ULAD / iLAD signaling
        el('DOCUMENT_SPECIFIC_DATA_SETS', {
          children: [
            el('DOCUMENT_SPECIFIC_DATA_SET', {
              children: [
                el('URLA', {
                  children: [
                    el('URLA_DETAIL', {
                      children: [
                        txt('BorrowerCount',
                          String((loanData.borrowers || []).length || 1)),
                        txt('ApplicationTakenMethodType', 'Internet'),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),

        // INTEREST_RATE_PERIODS — fixed for now
        rate ? el('INTEREST_RATE_PERIODS', {
          children: [
            el('INTEREST_RATE_PERIOD', {
              children: [
                txt('InterestRatePercent', rate),
              ],
            }),
          ],
        }) : '',

        // LOAN_DETAIL — application date, balloon, prepayment penalty etc.
        el('LOAN_DETAIL', {
          children: [
            txt('ApplicationReceivedDate',
              fmtDate(loanData.application_received_at || loanData.created_at)),
            txt('LoanAffordableIndicator', 'false'),
            txt('LoanRepaymentType', 'Standard'),
            txt('BalloonIndicator', 'false'),
            txt('PrepaymentPenaltyIndicator', 'false'),
            txt('InterestOnlyIndicator', 'false'),
            txt('NegativeAmortizationIndicator', 'false'),
          ],
        }),

        // LOAN_IDENTIFIERS — the loan_number both for our records and as
        // LenderLoanIdentifier per ULAD.
        el('LOAN_IDENTIFIERS', {
          children: [
            el('LOAN_IDENTIFIER', {
              children: [
                txt('LoanIdentifier', loanData.loan_number),
                txt('LoanIdentifierType', 'LenderLoan'),
              ],
            }),
          ],
        }),

        // LTV
        ltvPct != null ? el('LTV', {
          children: [
            el('LTV_DETAIL', {
              children: [
                txt('LTVRatioPercent', Number(ltvPct).toFixed(3)),
              ],
            }),
          ],
        }) : '',

        // MI_DATA (mortgage insurance) — placeholder; fill in when MI engine ships
        // Skipped for now — MI is computed by a separate MI engine.

        // PAYMENT
        monthlyPI ? el('PAYMENT', {
          children: [
            el('PAYMENT_RULE', {
              children: [
                txt('InitialPrincipalAndInterestPaymentAmount',
                  fmtMoneyDollars(monthlyPI)),
              ],
            }),
          ],
        }) : '',

        // QUALIFICATION (DTI)
        loanData.dti_back_pct != null ? el('QUALIFICATION', {
          children: [
            txt('TotalLiabilitiesMonthlyPaymentAmount', null),    // computed by AUS
            txt('TotalDebtExpenseRatioPercent',
              Number(loanData.dti_back_pct).toFixed(3)),
          ],
        }) : '',

        // TERMS_OF_LOAN
        el('TERMS_OF_LOAN', {
          children: [
            txt('AssumabilityIndicator', 'false'),
            txt('BaseLoanAmount', loanAmt),
            txt('LoanPurposeType', purposeMisMo),
            txt('MortgageType',
              PROGRAM_TO_MORTGAGE_TYPE[loanData.program] || 'Conventional'),
            txt('NoteAmount', loanAmt),
            txt('NoteRatePercent', rate),
            // MI signal — assume MI required if LTV > 80 and program=Conv
            (ltvPct != null && ltvPct > 80 && loanData.program === 'conv')
              ? txt('MIRequiredIndicator', 'true') : '',
          ],
        }),

        // REFINANCE — only when applicable
        purposeMisMo === 'Refinance' ? el('REFINANCE', {
          children: [
            txt('RefinanceCashOutDeterminationType',
              REFI_CASHOUT_MAP[loanData.purpose] || 'NoCashOut'),
          ],
        }) : '',
      ],
    });

    return el('LOANS', { children: [loan] });
  }

  function computeMonthlyPI(loanAmountCents, rateBps, termMonths) {
    if (!loanAmountCents || rateBps == null || !termMonths) return null;
    var P = Number(loanAmountCents) / 100;
    var r = (Number(rateBps) / 10000) / 12;
    var n = Number(termMonths);
    if (r === 0) return Math.round((P / n) * 100);
    var pi = (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    return Math.round(pi * 100);
  }

  function computeCashToClose(loanData) {
    if (loanData.purpose !== 'purchase') return null;
    var price = Number(loanData.purchase_price_cents) || 0;
    var loanAmt = Number(loanData.loan_amount_cents) || 0;
    var down = price - loanAmt;
    if (down <= 0) return null;
    return fmtMoneyDollars(down);
  }

  // ─── PARTIES ─────────────────────────────────────────────────────────────
  // PARTIES is the heaviest section. Each borrower, the LO, the lender,
  // and (when present) employer parties for borrower employment all go
  // here. We emit them in this order: lender, LO, borrowers, employers.
  function buildParties(loanData) {
    var partyXml = [];

    partyXml.push(buildLenderParty(loanData));
    if (loanData.lo) partyXml.push(buildLoanOfficerParty(loanData.lo));

    (loanData.borrowers || []).forEach(function (b, i) {
      partyXml.push(buildBorrowerParty(b, i));

      // Each borrower's employer(s) — emitted as separate PARTY rows.
      // Self-employment is modeled as employer=null with EmploymentClassificationType.
      var employments = b.employments || (b.employer ? [b.employer] : []);
      employments.forEach(function (emp, ei) {
        if (emp && emp.employer_name) {
          partyXml.push(buildEmployerParty(emp, i, ei));
        }
      });
    });

    return el('PARTIES', { children: partyXml.filter(Boolean) });
  }

  function buildLenderParty(loanData) {
    var b = loanData.branch || {};
    return el('PARTY', {
      attrs: { 'xlink:label': lenderLabel() },
      children: [
        el('LEGAL_ENTITY', {
          children: [
            el('LEGAL_ENTITY_DETAIL', {
              children: [txt('FullName', b.name)],
            }),
          ],
        }),
        el('ADDRESSES', {
          children: [buildAddress(b.address)],
        }),
        el('ROLES', {
          children: [
            el('ROLE', {
              children: [
                el('ROLE_DETAIL', {
                  children: [txt('PartyRoleType', 'NotePayTo')],
                }),
              ],
            }),
          ],
        }),
        // NMLS / state license identifiers
        (b.nmls_id || b.license_number) ? el('LICENSES', {
          children: [
            b.nmls_id ? el('LICENSE', {
              children: [
                el('LICENSE_DETAIL', {
                  children: [
                    txt('LicenseIdentifier', b.nmls_id),
                    txt('LicenseIssuingAuthorityName', 'NMLS'),
                  ],
                }),
              ],
            }) : '',
            b.license_number ? el('LICENSE', {
              children: [
                el('LICENSE_DETAIL', {
                  children: [
                    txt('LicenseIdentifier', b.license_number),
                    txt('LicenseIssuingAuthorityName', 'StateLicense'),
                  ],
                }),
              ],
            }) : '',
          ],
        }) : '',
      ],
    });
  }

  function buildLoanOfficerParty(lo) {
    return el('PARTY', {
      attrs: { 'xlink:label': loanOfficerLabel() },
      children: [
        el('INDIVIDUAL', {
          children: [
            el('NAME', {
              children: nameFromFullName(lo.full_name),
            }),
            lo.email ? el('CONTACT_POINTS', {
              children: [
                el('CONTACT_POINT', {
                  children: [
                    el('CONTACT_POINT_EMAIL', {
                      children: [txt('ContactPointEmailValue', lo.email)],
                    }),
                  ],
                }),
              ],
            }) : '',
          ],
        }),
        el('ROLES', {
          children: [
            el('ROLE', {
              children: [
                el('ROLE_DETAIL', {
                  children: [txt('PartyRoleType', 'LoanOriginator')],
                }),
              ],
            }),
          ],
        }),
        lo.nmls_id ? el('LICENSES', {
          children: [
            el('LICENSE', {
              children: [
                el('LICENSE_DETAIL', {
                  children: [
                    txt('LicenseIdentifier', lo.nmls_id),
                    txt('LicenseIssuingAuthorityName', 'NMLS'),
                  ],
                }),
              ],
            }),
          ],
        }) : '',
      ],
    });
  }

  function buildBorrowerParty(b, idx) {
    var ssn = formatSsnFull(b);
    var isPrimary = idx === 0;

    return el('PARTY', {
      attrs: { 'xlink:label': borrowerLabel(idx) },
      children: [
        el('INDIVIDUAL', {
          children: [
            el('NAME', { children: nameFromBorrower(b) }),

            // Contact points: phone and email
            (b.email || b.phone) ? el('CONTACT_POINTS', {
              children: [
                b.phone ? el('CONTACT_POINT', {
                  children: [
                    el('CONTACT_POINT_TELEPHONE', {
                      children: [
                        txt('ContactPointTelephoneValue', digitsOnly(b.phone)),
                      ],
                    }),
                  ],
                }) : '',
                b.email ? el('CONTACT_POINT', {
                  children: [
                    el('CONTACT_POINT_EMAIL', {
                      children: [txt('ContactPointEmailValue', b.email)],
                    }),
                  ],
                }) : '',
              ],
            }) : '',
          ],
        }),

        // Mailing address (current residence). MISMO uses ADDRESSES
        // collection so multiple can be sent (current + mailing + former).
        b.mailing_address ? el('ADDRESSES', {
          children: [buildAddress(b.mailing_address)],
        }) : '',

        // Roles — Borrower + classification (Primary / Coborrower)
        el('ROLES', {
          children: [
            el('ROLE', {
              children: [
                el('BORROWER', {
                  children: [
                    el('BORROWER_DETAIL', {
                      children: [
                        txt('BorrowerClassificationType',
                          isPrimary ? 'Primary' : 'Secondary'),
                        txt('BorrowerBirthDate', fmtDate(b.dob)),
                        txt('CitizenshipResidencyType',
                          CITIZENSHIP_MAP[b.citizenship] || 'USCitizen'),
                        txt('MaritalStatusType',
                          MARITAL_STATUS_MAP[b.marital_status]),
                      ],
                    }),
                  ],
                }),
                el('ROLE_DETAIL', {
                  children: [txt('PartyRoleType', 'Borrower')],
                }),
              ],
            }),
          ],
        }),

        // SSN. Omitted (not a placeholder) when we don't have the full 9.
        ssn ? el('TAXPAYER_IDENTIFIERS', {
          children: [
            el('TAXPAYER_IDENTIFIER', {
              children: [
                txt('TaxpayerIdentifierType', 'SocialSecurityNumber'),
                txt('TaxpayerIdentifierValue', ssn),
              ],
            }),
          ],
        }) : '',
      ],
    });
  }

  function buildEmployerParty(emp, borIdx, empIdx) {
    return el('PARTY', {
      attrs: { 'xlink:label': employerLabel(borIdx, empIdx) },
      children: [
        el('LEGAL_ENTITY', {
          children: [
            el('LEGAL_ENTITY_DETAIL', {
              children: [txt('FullName', emp.employer_name)],
            }),
          ],
        }),
        emp.employer_address ? el('ADDRESSES', {
          children: [buildAddress(emp.employer_address)],
        }) : '',
        el('ROLES', {
          children: [
            el('ROLE', {
              children: [
                el('ROLE_DETAIL', {
                  children: [txt('PartyRoleType', 'Employer')],
                }),
              ],
            }),
          ],
        }),
      ],
    });
  }

  // ─── NAME PARSING ────────────────────────────────────────────────────────
  function nameFromBorrower(b) {
    return [
      txt('FirstName', b.first_name),
      txt('MiddleName', b.middle_name),
      txt('LastName', b.last_name),
      txt('SuffixName', b.suffix),
    ];
  }

  // For LO records that store full_name as a single string. Best-effort split.
  function nameFromFullName(full) {
    if (!full) return [];
    var parts = String(full).trim().split(/\s+/);
    if (parts.length === 1) {
      return [txt('FirstName', parts[0])];
    }
    if (parts.length === 2) {
      return [txt('FirstName', parts[0]), txt('LastName', parts[1])];
    }
    // 3+ parts: first, middle joined, last
    return [
      txt('FirstName', parts[0]),
      txt('MiddleName', parts.slice(1, -1).join(' ')),
      txt('LastName', parts[parts.length - 1]),
    ];
  }

  // ─── RELATIONSHIPS ───────────────────────────────────────────────────────
  // Wires entities together via xlink:from / xlink:to. Without this the
  // AUS doesn't know which borrower owns which asset, which property is
  // collateral for which loan, etc.
  function buildRelationships(loanData) {
    var rels = [];

    // Loan ←→ each borrower (PartyRoleType=Borrower).
    (loanData.borrowers || []).forEach(function (_b, i) {
      rels.push(el('RELATIONSHIP', {
        attrs: {
          'xlink:from': loanLabel(),
          'xlink:to': borrowerLabel(i),
          'arcrole': 'urn:fdc:Mismo.org:2009:residential/LOAN_IsAssociatedWith_PARTY',
        },
      }));
    });

    // Loan ←→ subject property
    rels.push(el('RELATIONSHIP', {
      attrs: {
        'xlink:from': loanLabel(),
        'xlink:to': propertyLabel(),
        'arcrole': 'urn:fdc:Mismo.org:2009:residential/LOAN_IsAssociatedWith_PROPERTY',
      },
    }));

    // Loan ←→ lender
    rels.push(el('RELATIONSHIP', {
      attrs: {
        'xlink:from': loanLabel(),
        'xlink:to': lenderLabel(),
        'arcrole': 'urn:fdc:Mismo.org:2009:residential/LOAN_IsAssociatedWith_PARTY',
      },
    }));

    // Loan ←→ LO
    if (loanData.lo) {
      rels.push(el('RELATIONSHIP', {
        attrs: {
          'xlink:from': loanLabel(),
          'xlink:to': loanOfficerLabel(),
          'arcrole': 'urn:fdc:Mismo.org:2009:residential/LOAN_IsAssociatedWith_PARTY',
        },
      }));
    }

    // Borrower ←→ employer (one rel per employment)
    (loanData.borrowers || []).forEach(function (b, bi) {
      var employments = b.employments || (b.employer ? [b.employer] : []);
      employments.forEach(function (emp, ei) {
        if (!emp || !emp.employer_name) return;
        rels.push(el('RELATIONSHIP', {
          attrs: {
            'xlink:from': borrowerLabel(bi),
            'xlink:to': employerLabel(bi, ei),
            'arcrole': 'urn:fdc:Mismo.org:2009:residential/PARTY_IsEmployedBy_PARTY',
          },
        }));
      });
    });

    // Borrower ←→ each of their assets
    var assetIdx = 1;
    (loanData.borrowers || []).forEach(function (b, bi) {
      (b.assets || []).forEach(function () {
        rels.push(el('RELATIONSHIP', {
          attrs: {
            'xlink:from': borrowerLabel(bi),
            'xlink:to': 'Asset_' + String(assetIdx).padStart(3, '0'),
            'arcrole': 'urn:fdc:Mismo.org:2009:residential/PARTY_IsAssociatedWith_ASSET',
          },
        }));
        assetIdx++;
      });
    });

    // Borrower ←→ each of their liabilities
    var liabIdx = 1;
    (loanData.borrowers || []).forEach(function (b, bi) {
      (b.liabilities || []).forEach(function () {
        rels.push(el('RELATIONSHIP', {
          attrs: {
            'xlink:from': borrowerLabel(bi),
            'xlink:to': 'Liability_' + String(liabIdx).padStart(3, '0'),
            'arcrole': 'urn:fdc:Mismo.org:2009:residential/PARTY_IsAssociatedWith_LIABILITY',
          },
        }));
        liabIdx++;
      });
    });

    if (rels.length === 0) return '';
    return el('RELATIONSHIPS', { children: rels });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TOP-LEVEL ASSEMBLY
  // ═════════════════════════════════════════════════════════════════════════

  function buildAboutVersions() {
    return el('ABOUT_VERSIONS', {
      children: [
        el('ABOUT_VERSION', {
          children: [
            txt('CreatedDatetime', fmtDateTime(new Date().toISOString())),
            txt('DataVersionIdentifier', '3.4.0'),
            txt('DataVersionName', 'MISMO V3.4 ULAD'),
          ],
        }),
      ],
    });
  }

  function buildDeal(loanData) {
    // MISMO requires children inside DEAL in alphabetical order:
    //   ASSETS, COLLATERALS, EXPENSES, LIABILITIES, LOANS, PARTIES,
    //   RELATIONSHIPS, SERVICES.
    return el('DEAL', {
      children: [
        buildAssets(loanData),
        buildCollaterals(loanData),
        buildLiabilities(loanData),
        buildLoans(loanData),
        buildParties(loanData),
        buildRelationships(loanData),
      ],
    });
  }

  // Main entry. Returns the XML as a single-line string. Pretty-print
  // separately if you want it readable.
  function generateMISMO34(loanData) {
    if (!loanData || typeof loanData !== 'object') {
      throw new Error('generateMISMO34: loanData object is required');
    }

    var deal = buildDeal(loanData);
    if (!deal) {
      throw new Error('generateMISMO34: rendered DEAL was empty — check loanData');
    }

    var dealSets = el('DEAL_SETS', {
      children: [
        el('DEAL_SET', {
          children: [el('DEALS', { children: [deal] })],
        }),
      ],
    });

    var message = el('MESSAGE', {
      attrs: {
        'xmlns': 'http://www.mismo.org/residential/2009/schemas',
        'xmlns:xlink': 'http://www.w3.org/1999/xlink',
        'MISMOReferenceModelIdentifier': '3.4.0.272.13',
        'MessageType': 'Request',
      },
      children: [
        buildAboutVersions(),
        dealSets,
      ],
    });

    return '<?xml version="1.0" encoding="UTF-8"?>' + message;
  }

  // ─── DATA-SHAPE VALIDATION ───────────────────────────────────────────────
  // Runs a set of lightweight checks against loanData and returns a list
  // of warning strings for fields the AUS will likely flag. Use this in
  // the UI to surface "the AUS will reject this" before actually sending.
  function validateLoanDataShape(loanData) {
    var w = [];
    if (!loanData) { w.push('loanData is null'); return w; }

    if (!loanData.loan_number) w.push('loan_number is missing — DU rejects without an identifier');
    if (loanData.loan_amount_cents == null) w.push('loan_amount_cents is missing — required for DU/LP');
    if (loanData.rate_bps == null) w.push('rate_bps is missing — note rate is mandatory');
    if (!loanData.term_months) w.push('term_months is missing — amortization period is mandatory');
    if (!loanData.purpose) w.push('purpose is missing (purchase | refinance | cashout_refinance)');
    if (!loanData.property_address || !loanData.property_address.street) {
      w.push('property_address.street missing — subject property address is mandatory');
    }
    if (!loanData.property_address || !loanData.property_address.state) {
      w.push('property_address.state missing — required for state licensing checks');
    }

    var bs = loanData.borrowers || [];
    if (bs.length === 0) {
      w.push('borrowers list is empty — AUS needs at least one borrower');
    }
    bs.forEach(function (b, i) {
      var prefix = 'borrower[' + i + ']';
      if (!b.first_name || !b.last_name) w.push(prefix + ' name missing');
      if (!b.dob) w.push(prefix + ' dob missing — date of birth is mandatory');
      if (!b.ssn || digitsOnly(b.ssn)?.length !== 9) {
        w.push(prefix + ' ssn missing or not 9 digits — DU rejects without full SSN');
      }
      if (!b.email) w.push(prefix + ' email missing');
      if (!b.mailing_address || !b.mailing_address.street) {
        w.push(prefix + ' mailing_address missing — current residence is mandatory');
      }
      if (b.monthly_income_cents == null && (b.employments || []).length === 0) {
        w.push(prefix + ' income missing — provide monthly_income_cents and/or employments');
      }
    });

    if (loanData.purpose === 'purchase' && !loanData.purchase_price_cents) {
      w.push('purchase_price_cents missing on a purchase — required');
    }
    if (!loanData.appraised_value_cents) {
      w.push('appraised_value_cents missing — LTV cannot be computed; AUS will issue a finding');
    }

    return w;
  }

  // ─── EXPORT ──────────────────────────────────────────────────────────────
  window.OFMismo = {
    generateMISMO34: generateMISMO34,
    prettyPrintXml: prettyPrintXml,
    validateLoanDataShape: validateLoanDataShape,
    // Internals exposed for tests / dev console:
    _escapeXml: escapeXml,
    _el: el,
    _txt: txt,
  };
})();
