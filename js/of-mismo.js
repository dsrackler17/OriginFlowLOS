/* ═══════════════════════════════════════════════════════════════════════════
 * /js/of-mismo.js  ·  OriginFlow MISMO 3.4 interchange (import + export)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This is the handoff moat. Two surfaces depend on it, and they are mirror
 * images of each other, so they live in ONE module sharing ONE field map:
 *
 *   • IMPORT  (loans-new.html) — the intake card calls window.OF_parseMismo34(file).
 *               We parse a MISMO 3.4 .xml exported by Encompass / Calyx Point /
 *               LendingPad / Mortgage Cadence / BytePro / etc. and return an object
 *               whose keys line up with the wizard's `formData`. The wizard merges
 *               the keys it recognizes and drops the LO into Step 1 to review.
 *
 *   • EXPORT  (loan.html) — window.OF_exportMismo34(loan) takes a finished loan and
 *               emits valid-shaped MISMO 3.4 XML + a labeled filename, so the file
 *               can be imported into whatever system of record the shop runs. This
 *               is the "syncs to your system of record" story — universal, no API,
 *               no vendor permission.
 *
 * SCOPE — read this before assuming a field is missing by mistake
 * ---------------------------------------------------------------
 * v1 covers exactly what the intake card promises and what the checklist names:
 *   loan terms · subject property · borrower(s) · employment · income.
 * It deliberately DOES NOT map declarations, HMDA demographics, or
 * assets/liabilities/REO yet. Those are collected in the wizard by hand. Mapping
 * URLA declaration letters and HMDA enums wrong would write bad data into a real
 * loan file, which is worse than leaving them for human review. When we add them,
 * they slot into the same MAP table below. The honest product claim stays:
 * "import the finished file and review/tidy up," not "one click, done."
 *
 * MISMO 3.4 SHAPE WE TARGET (the ULAD/URLA DEAL tree)
 * ---------------------------------------------------
 *   MESSAGE > DEAL_SETS > DEAL_SET > DEALS > DEAL > {
 *     LOANS > LOAN > { TERMS_OF_LOAN, AMORTIZATION, MATURITY, LOAN_DETAIL,
 *                      LOAN_PRODUCT, CLOSING_INFORMATION }
 *     COLLATERALS > COLLATERAL > SUBJECT_PROPERTY > { ADDRESS, PROPERTY_DETAIL }
 *     PARTIES > PARTY(borrower) > { INDIVIDUAL, TAXPAYER_IDENTIFIERS,
 *                ROLES > ROLE > BORROWER > { BORROWER_DETAIL, RESIDENCES,
 *                EMPLOYERS, CURRENT_INCOME } }
 *   }
 * This is a faithful SUBSET of the MISMO Reference Model 3.4. It is not the full
 * 4,000-element XSD and won't pass strict schema validation as-is — element NAMES
 * and the DEAL nesting are correct, which is what real importers key on. Flagged
 * loudly so nobody mistakes this for a certified export.
 *
 * PARSER ROBUSTNESS
 * -----------------
 * Different vendors emit different namespace prefixes (none, MISMO:, P1:, …) and
 * nest optional containers slightly differently. So the parser is namespace-AGNOSTIC
 * (matches by localName via getElementsByTagNameNS('*', name)) and searches within
 * the nearest sensible ancestor rather than a rigid absolute path. Anything it can't
 * find is simply left unset — the wizard shows the blank field for the LO to fill.
 *
 * ENVIRONMENT
 * -----------
 * Browser: uses global DOMParser (import) and string building (export — no
 * serializer needed). Node test harness can inject a DOMParser (see of-mismo.test.js)
 * because the module reads DOMParser off the same root it attaches to.
 *
 * ASSUMPTIONS FLAGGED FOR RUNTIME CORRECTION (per house style — ship, then fix on
 * first real file rather than pre-validating every enum):
 *   • formData.loan_amount / property_value / down_payment are DOLLAR strings.
 *     The Supabase loan row is cents — normalizeLoanRow() divides by 100. If a
 *     column turns out not to be *_cents, the amount will be 100x off and obvious.
 *   • amortization_type values assumed 'fixed' | 'arm'/'adjustable'.
 *   • loan_program values assumed 'conventional' | 'fha' | 'va' | 'usda'.
 *   • occupancy values assumed to start with 'primary' | 'second' | 'investment'.
 *   • b*_citizenship assumed 'us_citizen' | 'permanent_resident' | 'non_permanent'.
 *   • b*_housing assumed 'own' | 'rent' | 'rent_free'.
 * Bidirectional enum maps below; unknown values pass through untranslated so they
 * surface in review instead of being silently dropped.
 * ═══════════════════════════════════════════════════════════════════════════ */

(function (root) {
  'use strict';

  var PARSER_VERSION = 'of-mismo/1.0.0';

  // ─── Enum maps (OriginFlow value  ↔  MISMO enum) ─────────────────────────
  // Each map is OF→MISMO; we derive the reverse at call time so there's one
  // source of truth. Keys are lowercased for tolerant matching.
  var ENUM = {
    purpose: {            // LoanPurposeType
      purchase: 'Purchase',
      refinance: 'Refinance',
      cashout_refi: 'Refinance',         // DB enum value; + cash-out flag, see below
      construction: 'Other'              // MISMO has no LoanPurposeType=Construction
    },
    amortization_type: {  // AmortizationType
      // Wizard select values: fixed | arm_5_1 | arm_7_1 | arm_10_1 | other.
      // MISMO AmortizationType can't disambiguate the ARM term, so on IMPORT an
      // AdjustableRate resolves to arm_5_1 (most common) as a *reviewable* default —
      // the LO confirms the exact term in the wizard. Flagged, not silent.
      fixed: 'Fixed',
      arm_5_1: 'AdjustableRate',
      arm_7_1: 'AdjustableRate',
      arm_10_1: 'AdjustableRate',
      other: 'Other',
      arm: 'AdjustableRate',          // tolerate legacy/loose input on export
      adjustable: 'AdjustableRate'
    },
    loan_program: {       // MortgageType
      conventional: 'Conventional',
      fha: 'FHA',
      va: 'VA',
      usda: 'USDARuralDevelopment'
    },
    occupancy: {          // PropertyUsageType — wizard values: primary|secondary|investment
      primary: 'PrimaryResidence',
      secondary: 'SecondHome',
      investment: 'Investment',
      // tolerated synonyms on export input; reverse map returns the canonical
      // wizard value above because those keys come first.
      primary_residence: 'PrimaryResidence',
      second_home: 'SecondHome',
      investment_property: 'Investment'
    },
    marital: {            // MaritalStatusType
      married: 'Married',
      unmarried: 'Unmarried',
      single: 'Unmarried',
      separated: 'Separated'
    },
    citizenship: {        // CitizenshipResidencyType
      us_citizen: 'USCitizen',
      permanent_resident: 'PermanentResidentAlien',
      non_permanent: 'NonPermanentResidentAlien',
      non_permanent_resident: 'NonPermanentResidentAlien'
    },
    housing: {            // BorrowerResidencyBasisType — wizard values: own|rent|no_primary
      own: 'Own',
      rent: 'Rent',
      no_primary: 'LivingRentFree',
      rent_free: 'LivingRentFree'     // tolerated synonym on export input
    }
  };

  function mapOF2MISMO(field, v) {
    if (v == null || v === '') return '';
    var m = ENUM[field]; if (!m) return String(v);
    var hit = m[String(v).toLowerCase()];
    return hit != null ? hit : String(v); // pass unknown through, don't drop
  }
  function mapMISMO2OF(field, v) {
    if (v == null || v === '') return '';
    var m = ENUM[field]; if (!m) return String(v);
    var want = String(v).toLowerCase();
    for (var k in m) { if (String(m[k]).toLowerCase() === want) return k; }
    return String(v).toLowerCase(); // pass unknown through lowercased
  }

  // ─── XML escaping + tiny builder (export side) ───────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  // el('Tag', value) → "<Tag>value</Tag>" or '' when value is empty so we never
  // emit hollow elements. el('Tag', value, true) forces emit even when empty.
  function el(tag, value, force) {
    if ((value == null || value === '') && !force) return '';
    return '<' + tag + '>' + esc(value) + '</' + tag + '>';
  }
  function wrap(tag, inner) {
    if (!inner) return '';
    return '<' + tag + '>' + inner + '</' + tag + '>';
  }

  // amounts: formData carries dollar strings; emit a clean numeric string.
  function num(v) {
    if (v == null || v === '') return '';
    var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? String(n) : '';
  }
  function boolIndicator(v) {
    var s = String(v == null ? '' : v).toLowerCase();
    if (s === 'yes' || s === 'true' || s === '1') return 'true';
    if (s === 'no' || s === 'false' || s === '0') return 'false';
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT — formData-shaped object  →  MISMO 3.4 XML string
  // ═══════════════════════════════════════════════════════════════════════════

  function buildBorrowerPartyXml(d, prefix) {
    var fn = d[prefix + '_first_name'];
    var ln = d[prefix + '_last_name'];
    if (!fn && !ln) return ''; // no borrower → no PARTY (b2 commonly absent)

    var name = wrap('NAME',
      el('FirstName', d[prefix + '_first_name']) +
      el('MiddleName', d[prefix + '_middle']) +
      el('LastName', d[prefix + '_last_name']) +
      el('SuffixName', d[prefix + '_suffix'])
    );

    var contactPoints = '';
    if (d[prefix + '_email']) {
      contactPoints += wrap('CONTACT_POINT',
        wrap('CONTACT_POINT_EMAIL', el('ContactPointEmailValue', d[prefix + '_email'])) +
        wrap('CONTACT_POINT_DETAIL', el('ContactPointRoleType', 'Home'))
      );
    }
    if (d[prefix + '_phone']) {
      contactPoints += wrap('CONTACT_POINT',
        wrap('CONTACT_POINT_TELEPHONE', el('ContactPointTelephoneValue', d[prefix + '_phone'])) +
        wrap('CONTACT_POINT_DETAIL', el('ContactPointRoleType', 'Mobile'))
      );
    }
    if (d[prefix + '_phone_alt']) {
      contactPoints += wrap('CONTACT_POINT',
        wrap('CONTACT_POINT_TELEPHONE', el('ContactPointTelephoneValue', d[prefix + '_phone_alt'])) +
        wrap('CONTACT_POINT_DETAIL', el('ContactPointRoleType', 'Home'))
      );
    }
    var individual = wrap('INDIVIDUAL', name + wrap('CONTACT_POINTS', contactPoints));

    var taxId = d[prefix + '_ssn'] ? wrap('TAXPAYER_IDENTIFIERS',
      wrap('TAXPAYER_IDENTIFIER',
        el('TaxpayerIdentifierType', 'SocialSecurityNumber') +
        el('TaxpayerIdentifierValue', d[prefix + '_ssn'])
      )) : '';

    var borrowerDetail = wrap('BORROWER_DETAIL',
      el('BorrowerBirthDate', d[prefix + '_dob']) +
      el('MaritalStatusType', mapOF2MISMO('marital', d[prefix + '_marital'])) +
      el('DependentCount', d[prefix + '_dependents']) +
      el('CitizenshipResidencyType', mapOF2MISMO('citizenship', d[prefix + '_citizenship']))
    );

    // Current residence
    var residence = '';
    if (d[prefix + '_current_address'] || d[prefix + '_current_city']) {
      var resAddr = wrap('ADDRESS',
        el('AddressLineText', d[prefix + '_current_address']) +
        el('CityName', d[prefix + '_current_city']) +
        el('StateCode', d[prefix + '_current_state']) +
        el('PostalCode', d[prefix + '_current_zip'])
      );
      var months = '';
      var yrs = parseInt(d[prefix + '_current_years'] || '0', 10) || 0;
      var mos = parseInt(d[prefix + '_current_months'] || '0', 10) || 0;
      if (yrs || mos) months = String(yrs * 12 + mos);
      var resDetail = wrap('RESIDENCE_DETAIL',
        el('BorrowerResidencyType', 'Current') +
        el('BorrowerResidencyBasisType', mapOF2MISMO('housing', d[prefix + '_housing'])) +
        el('BorrowerResidencyDurationMonthsCount', months) +
        el('MonthlyRentAmount', num(d[prefix + '_monthly_rent']))
      );
      residence = wrap('RESIDENCES', wrap('RESIDENCE', resAddr + resDetail));
    }

    // Employers + per-employer income
    var employersXml = '';
    var empList = Array.isArray(d[prefix + '_employment']) ? d[prefix + '_employment'] : [];
    empList.forEach(function (e) {
      if (!e || (!e.employer && !e.position)) return;
      var legalEntity = wrap('LEGAL_ENTITY',
        wrap('LEGAL_ENTITY_DETAIL', el('FullName', e.employer)));
      var employment = wrap('EMPLOYMENT',
        el('EmploymentStatusType', e.status === 'prior' ? 'Prior' : 'Current') +
        el('EmploymentPositionDescription', e.position) +
        el('EmploymentStartDate', e.start_date) +
        el('EmploymentEndDate', e.end_date) +
        el('EmploymentBorrowerSelfEmployedIndicator', boolIndicator(e.self_employed))
      );
      // income items tied to this employer
      var incomeItems = '';
      if (num(e.monthly_base)) {
        incomeItems += wrap('CURRENT_INCOME_ITEM', wrap('CURRENT_INCOME_ITEM_DETAIL',
          el('IncomeType', 'Base') + el('CurrentIncomeMonthlyTotalAmount', num(e.monthly_base))));
      }
      if (num(e.monthly_other)) {
        incomeItems += wrap('CURRENT_INCOME_ITEM', wrap('CURRENT_INCOME_ITEM_DETAIL',
          el('IncomeType', 'Overtime') + el('CurrentIncomeMonthlyTotalAmount', num(e.monthly_other))));
      }
      employersXml += wrap('EMPLOYER', legalEntity + employment +
        (incomeItems ? wrap('CURRENT_INCOME', incomeItems) : ''));
    });
    var employers = employersXml ? wrap('EMPLOYERS', employersXml) : '';

    // Non-employment / other income
    var otherIncomeXml = '';
    var otherList = Array.isArray(d[prefix + '_other_income']) ? d[prefix + '_other_income'] : [];
    otherList.forEach(function (oi) {
      if (!oi || !num(oi.monthly_amount)) return;
      otherIncomeXml += wrap('CURRENT_INCOME_ITEM', wrap('CURRENT_INCOME_ITEM_DETAIL',
        el('IncomeType', oi.kind || 'Other') +
        el('CurrentIncomeMonthlyTotalAmount', num(oi.monthly_amount)) +
        el('IncomeDescription', oi.description)
      ));
    });
    var otherIncome = otherIncomeXml ? wrap('CURRENT_INCOME', otherIncomeXml) : '';

    var borrower = wrap('BORROWER', borrowerDetail + residence + employers + otherIncome);
    var role = wrap('ROLE', borrower + wrap('ROLE_DETAIL', el('PartyRoleType', 'Borrower')));

    return wrap('PARTY', individual + taxId + wrap('ROLES', role));
  }

  function buildMismo34(d) {
    d = d || {};

    // LOAN
    var termsOfLoan = wrap('TERMS_OF_LOAN',
      el('BaseLoanAmount', num(d.loan_amount)) +
      el('LoanPurposeType', mapOF2MISMO('purpose', d.purpose)) +
      el('NoteRatePercent', d.interest_rate) +
      (String(d.purpose).toLowerCase() === 'cashout_refi'
        ? el('RefinanceCashOutDeterminationType', 'CashOut') : '')
    );
    var amortMonths = d.loan_term_months;
    var amortization = wrap('AMORTIZATION', wrap('AMORTIZATION_RULE',
      el('AmortizationType', mapOF2MISMO('amortization_type', d.amortization_type)) +
      el('LoanAmortizationPeriodCount', amortMonths) +
      (amortMonths ? el('LoanAmortizationPeriodType', 'Month') : '')
    ));
    var maturity = amortMonths ? wrap('MATURITY', wrap('MATURITY_RULE',
      el('LoanMaturityPeriodCount', amortMonths) + el('LoanMaturityPeriodType', 'Month')
    )) : '';
    var loanProduct = wrap('LOAN_PRODUCT', wrap('LOAN_PRODUCT_DETAIL',
      el('MortgageType', mapOF2MISMO('loan_program', d.loan_program))));
    var downPmt = num(d.down_payment) ? wrap('DOWN_PAYMENTS', wrap('DOWN_PAYMENT',
      el('DownPaymentAmount', num(d.down_payment)))) : '';
    var closing = d.estimated_closing_date ? wrap('CLOSING_INFORMATION',
      wrap('CLOSING_INFORMATION_DETAIL', el('ClosingDate', d.estimated_closing_date))) : '';
    var loan = wrap('LOANS', wrap('LOAN',
      termsOfLoan + amortization + maturity + loanProduct + downPmt + closing));

    // SUBJECT PROPERTY
    var propAddr = wrap('ADDRESS',
      el('AddressLineText', d.property_address_street) +
      el('AddressUnitIdentifier', d.property_address_unit) +
      el('CityName', d.property_address_city) +
      el('StateCode', d.property_address_state) +
      el('PostalCode', d.property_address_zip) +
      el('CountyName', d.property_address_county)
    );
    var propDetail = wrap('PROPERTY_DETAIL',
      el('FinancedUnitCount', d.property_units) +
      el('PropertyEstimatedValueAmount', num(d.property_value)) +
      el('PropertyUsageType', mapOF2MISMO('occupancy', d.occupancy)) +
      el('ConstructionMethodType',
        String(d.manufactured_home).toLowerCase() === 'yes' ? 'Manufactured' : '') +
      el('PropertyStructureBuiltYear', d.property_year_built)
    );
    var collateral = (propAddr || propDetail) ? wrap('COLLATERALS', wrap('COLLATERAL',
      wrap('SUBJECT_PROPERTY', propAddr + propDetail))) : '';

    // PARTIES
    var parties = wrap('PARTIES',
      buildBorrowerPartyXml(d, 'b1') + buildBorrowerPartyXml(d, 'b2'));

    var deal = wrap('DEAL', loan + collateral + parties);
    var tree = wrap('DEAL_SETS', wrap('DEAL_SET', wrap('DEALS', deal)));

    var xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" ' +
      'MISMOReferenceModelIdentifier="3.4.0" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      '  <ABOUT_VERSIONS><ABOUT_VERSION>' +
      el('CreatedDatetime', new Date().toISOString()) +
      el('DataVersionName', PARSER_VERSION) +
      '</ABOUT_VERSION></ABOUT_VERSIONS>\n  ' +
      tree + '\n</MESSAGE>\n';
    return xml;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IMPORT — MISMO 3.4 XML string  →  formData-shaped object
  // ═══════════════════════════════════════════════════════════════════════════

  function getDOMParser() {
    if (root && root.DOMParser) return new root.DOMParser();
    if (typeof DOMParser !== 'undefined') return new DOMParser();
    throw new Error('No DOMParser available in this environment.');
  }

  // ns-agnostic helpers — match by localName regardless of prefix/namespace.
  function all(node, name) {
    if (!node) return [];
    var list = node.getElementsByTagNameNS ? node.getElementsByTagNameNS('*', name)
                                           : node.getElementsByTagName(name);
    return Array.prototype.slice.call(list || []);
  }
  function first(node, name) { var a = all(node, name); return a.length ? a[0] : null; }
  function text(node, name) {
    var n = first(node, name);
    return n && n.textContent != null ? n.textContent.trim() : '';
  }
  // text of a child only when found WITHIN this node's subtree (already scoped
  // because we call from the relevant ancestor).

  function parseMismo34(xmlString) {
    var doc = getDOMParser().parseFromString(String(xmlString || ''), 'application/xml');
    // DOMParser reports malformed XML as a <parsererror> node (browser) or throws (xmldom).
    var perr = first(doc, 'parsererror');
    if (perr) throw new Error('Not valid XML: ' + (perr.textContent || '').slice(0, 120));

    var deal = first(doc, 'DEAL') || doc.documentElement;
    if (!deal) throw new Error('No <DEAL> found — is this a MISMO 3.4 file?');

    var out = {};
    function set(k, v) { if (v !== '' && v != null) out[k] = v; }

    // ── LOAN / TERMS ──
    var loan = first(deal, 'LOAN');
    var terms = first(loan || deal, 'TERMS_OF_LOAN');
    if (terms) {
      set('loan_amount', text(terms, 'BaseLoanAmount'));
      var purpose = mapMISMO2OF('purpose', text(terms, 'LoanPurposeType'));
      // promote Refinance → cashout_refi if the cash-out flag says so
      if (purpose === 'refinance') {
        var co = text(terms, 'RefinanceCashOutDeterminationType');
        if (/cashout/i.test(co)) purpose = 'cashout_refi';
      }
      set('purpose', purpose);
      set('interest_rate', text(terms, 'NoteRatePercent'));
    }
    var amort = first(loan || deal, 'AMORTIZATION');
    if (amort) {
      set('amortization_type', mapMISMO2OF('amortization_type', text(amort, 'AmortizationType')));
      set('loan_term_months', text(amort, 'LoanAmortizationPeriodCount'));
    }
    if (loan && !out.loan_term_months) {
      var mat = first(loan, 'MATURITY');
      if (mat) set('loan_term_months', text(mat, 'LoanMaturityPeriodCount'));
    }
    var product = first(loan || deal, 'LOAN_PRODUCT');
    if (product) set('loan_program', mapMISMO2OF('loan_program', text(product, 'MortgageType')));
    var dp = first(loan || deal, 'DOWN_PAYMENT');
    if (dp) set('down_payment', text(dp, 'DownPaymentAmount'));
    var closing = first(loan || deal, 'CLOSING_INFORMATION');
    if (closing) set('estimated_closing_date', text(closing, 'ClosingDate'));

    // ── SUBJECT PROPERTY ──
    var subj = first(deal, 'SUBJECT_PROPERTY');
    if (subj) {
      var addr = first(subj, 'ADDRESS');
      if (addr) {
        set('property_address_street', text(addr, 'AddressLineText'));
        set('property_address_unit', text(addr, 'AddressUnitIdentifier'));
        set('property_address_city', text(addr, 'CityName'));
        set('property_address_state', text(addr, 'StateCode'));
        set('property_address_zip', text(addr, 'PostalCode'));
        set('property_address_county', text(addr, 'CountyName'));
      }
      var pd = first(subj, 'PROPERTY_DETAIL');
      if (pd) {
        set('property_units', text(pd, 'FinancedUnitCount'));
        set('property_value', text(pd, 'PropertyEstimatedValueAmount'));
        set('occupancy', mapMISMO2OF('occupancy', text(pd, 'PropertyUsageType')));
        set('property_year_built', text(pd, 'PropertyStructureBuiltYear'));
        if (/manufactured/i.test(text(pd, 'ConstructionMethodType'))) set('manufactured_home', 'yes');
      }
    }

    // ── BORROWERS ──
    // Collect PARTY nodes that carry a BORROWER role; first → b1, second → b2.
    var partyNodes = all(deal, 'PARTY').filter(function (p) { return first(p, 'BORROWER'); });
    partyNodes.slice(0, 2).forEach(function (party, idx) {
      var px = idx === 0 ? 'b1' : 'b2';
      var name = first(party, 'NAME');
      if (name) {
        set(px + '_first_name', text(name, 'FirstName'));
        set(px + '_middle', text(name, 'MiddleName'));
        set(px + '_last_name', text(name, 'LastName'));
        set(px + '_suffix', text(name, 'SuffixName'));
      }
      // taxpayer id (SSN)
      all(party, 'TAXPAYER_IDENTIFIER').forEach(function (t) {
        if (/social/i.test(text(t, 'TaxpayerIdentifierType'))) {
          set(px + '_ssn', text(t, 'TaxpayerIdentifierValue'));
        }
      });
      // contact points
      all(party, 'CONTACT_POINT').forEach(function (cp) {
        var email = text(cp, 'ContactPointEmailValue');
        var phone = text(cp, 'ContactPointTelephoneValue');
        if (email && !out[px + '_email']) set(px + '_email', email);
        if (phone) {
          if (!out[px + '_phone']) set(px + '_phone', phone);
          else if (px === 'b1' && !out.b1_phone_alt) set('b1_phone_alt', phone);
        }
      });
      var bd = first(party, 'BORROWER_DETAIL');
      if (bd) {
        set(px + '_dob', text(bd, 'BorrowerBirthDate'));
        set(px + '_marital', mapMISMO2OF('marital', text(bd, 'MaritalStatusType')));
        set(px + '_dependents', text(bd, 'DependentCount'));
        set(px + '_citizenship', mapMISMO2OF('citizenship', text(bd, 'CitizenshipResidencyType')));
      }
      // current residence
      var res = all(party, 'RESIDENCE').filter(function (r) {
        return /current/i.test(text(r, 'BorrowerResidencyType')) || all(party, 'RESIDENCE').length === 1;
      })[0] || first(party, 'RESIDENCE');
      if (res) {
        var ra = first(res, 'ADDRESS');
        if (ra) {
          set(px + '_current_address', text(ra, 'AddressLineText'));
          set(px + '_current_city', text(ra, 'CityName'));
          set(px + '_current_state', text(ra, 'StateCode'));
          set(px + '_current_zip', text(ra, 'PostalCode'));
        }
        set(px + '_housing', mapMISMO2OF('housing', text(res, 'BorrowerResidencyBasisType')));
        var mc = parseInt(text(res, 'BorrowerResidencyDurationMonthsCount') || '0', 10) || 0;
        if (mc) { set(px + '_current_years', String(Math.floor(mc / 12))); set(px + '_current_months', String(mc % 12)); }
        var rent = text(res, 'MonthlyRentAmount'); if (rent) set(px + '_monthly_rent', rent);
      }
      // employment + income
      var emps = all(party, 'EMPLOYER').map(function (emp) {
        var empl = first(emp, 'EMPLOYMENT');
        var rec = {
          employer: text(first(emp, 'LEGAL_ENTITY') || emp, 'FullName'),
          position: empl ? text(empl, 'EmploymentPositionDescription') : '',
          start_date: empl ? text(empl, 'EmploymentStartDate') : '',
          end_date: empl ? text(empl, 'EmploymentEndDate') : '',
          status: empl && /prior/i.test(text(empl, 'EmploymentStatusType')) ? 'prior' : 'current',
          monthly_base: '', monthly_other: '',
          self_employed: empl && /true/i.test(text(empl, 'EmploymentBorrowerSelfEmployedIndicator')) ? 'yes' : 'no'
        };
        all(emp, 'CURRENT_INCOME_ITEM_DETAIL').forEach(function (it) {
          var t = text(it, 'IncomeType');
          var amt = text(it, 'CurrentIncomeMonthlyTotalAmount');
          if (/base/i.test(t)) rec.monthly_base = amt;
          else if (amt) rec.monthly_other = amt;
        });
        return rec;
      }).filter(function (r) { return r.employer || r.position; });
      if (emps.length) set(px + '_employment', emps);

      // non-employment income: CURRENT_INCOME directly under BORROWER (not in EMPLOYER)
      var borrower = first(party, 'BORROWER');
      var otherInc = [];
      all(borrower, 'CURRENT_INCOME').forEach(function (ci) {
        // skip income blocks that live inside an EMPLOYER (already captured)
        var p = ci.parentNode;
        var insideEmployer = false;
        while (p && p !== borrower) {
          if (p.localName === 'EMPLOYER' || p.nodeName.split(':').pop() === 'EMPLOYER') { insideEmployer = true; break; }
          p = p.parentNode;
        }
        if (insideEmployer) return;
        all(ci, 'CURRENT_INCOME_ITEM_DETAIL').forEach(function (it) {
          var amt = text(it, 'CurrentIncomeMonthlyTotalAmount');
          if (!amt) return;
          otherInc.push({
            kind: text(it, 'IncomeType') || 'Other',
            monthly_amount: amt,
            description: text(it, 'IncomeDescription')
          });
        });
      });
      if (otherInc.length) set(px + '_other_income', otherInc);
    });

    if (partyNodes.length > 1 && out.b2_first_name) out.hasCoborrower = true;

    out._mismo_parser = PARSER_VERSION;
    return out;
  }

  // ─── normalizeLoanRow: Supabase loan row  →  formData shape (export adapter) ─
  // The loan row written by loans-new.html carries application_data = the full
  // wizard formData snapshot (employment, income, SSN, DOB, residences — the rich
  // fields the lean top-level columns don't hold). So we use that snapshot as the
  // BASE, then overlay the authoritative top-level columns (loan_amount_cents,
  // rate_bps, term_months, purpose, program, occupancy, property_address jsonb,
  // appraised_value_cents) so any edits made in the workspace after intake win
  // over the stale snapshot. Loans with no application_data (older or non-wizard)
  // still export a valid, leaner file from columns + the borrowers join alone.
  // ASSUMPTION-HEAVY by design; anything missing is simply omitted (el() drops empties).
  function normalizeLoanRow(loan) {
    if (!loan) return {};
    var dollars = function (cents) { return cents == null ? '' : String(Number(cents) / 100); };

    // base = rich intake snapshot when present
    var d = {};
    if (loan.application_data && typeof loan.application_data === 'object') {
      d = Object.assign({}, loan.application_data);
      delete d.intake_source; // bookkeeping, not a MISMO field
    }
    function ov(k, v) { if (v !== '' && v != null) d[k] = v; } // overlay only real values

    ov('loan_amount', loan.loan_amount_cents != null ? dollars(loan.loan_amount_cents) : '');
    ov('purpose', loan.purpose);
    ov('loan_program', loan.program || loan.loan_program);
    ov('loan_term_months', loan.term_months || loan.loan_term_months);
    ov('interest_rate', loan.rate_bps != null ? String(Number(loan.rate_bps) / 100) : loan.interest_rate);
    ov('occupancy', loan.occupancy);
    ov('property_type', loan.property_type);
    ov('estimated_closing_date', loan.estimated_closing_date || loan.closing_date);

    var a = loan.property_address || {};
    ov('property_address_street', a.street);
    ov('property_address_unit', a.unit);
    ov('property_address_city', a.city);
    ov('property_address_state', a.state);
    ov('property_address_zip', a.zip);
    ov('property_address_county', a.county);
    ov('property_value', loan.appraised_value_cents != null ? dollars(loan.appraised_value_cents) : loan.property_value);
    if (a.units != null) ov('property_units', a.units);

    // borrowers join → current names / email / phone (authoritative); do NOT
    // clobber ssn/dob/employment/income carried in application_data.
    var bs = (loan.borrowers || [])
      .slice().sort(function (x, y) { return (x.position || 0) - (y.position || 0); })
      .map(function (b) { return b.borrower || b; })
      .filter(Boolean);
    [['b1', bs[0]], ['b2', bs[1]]].forEach(function (pair) {
      var px = pair[0], b = pair[1]; if (!b) return;
      ov(px + '_first_name', b.first_name);
      ov(px + '_last_name', b.last_name);
      if (b.middle_name) ov(px + '_middle', b.middle_name);
      ov(px + '_email', b.email);
      ov(px + '_phone', b.phone);
    });
    return d;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  // IMPORT hook the loans-new.html intake card already calls.
  function OF_parseMismo34(file) {
    return new Promise(function (resolve, reject) {
      try {
        if (!file) return reject(new Error('No file provided.'));
        if (typeof root.FileReader === 'undefined') {
          // node/test path: allow passing a string directly
          if (typeof file === 'string') return resolve(parseMismo34(file));
          return reject(new Error('FileReader unavailable.'));
        }
        var reader = new root.FileReader();
        reader.onload = function () {
          try { resolve(parseMismo34(String(reader.result || ''))); }
          catch (e) { reject(e); }
        };
        reader.onerror = function () { reject(new Error('Could not read the file.')); };
        reader.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // EXPORT hook for loan.html. Accepts either a Supabase loan row (normalized)
  // or an already-formData-shaped object (set opts.raw = true to skip normalize).
  // Returns { xml, filename }. Pass opts.download = true to trigger a browser
  // download in one call.
  function OF_exportMismo34(loanOrFormData, opts) {
    opts = opts || {};
    var d = opts.raw ? (loanOrFormData || {}) : normalizeLoanRow(loanOrFormData);
    var xml = buildMismo34(d);
    var num = (loanOrFormData && (loanOrFormData.loan_number || loanOrFormData.loanNumber)) || 'loan';
    var filename = String(num).replace(/[^\w.-]+/g, '_') + '_mismo_3.4.xml';
    if (opts.download && root.document && root.URL && root.URL.createObjectURL) {
      var blob = new root.Blob([xml], { type: 'application/xml' });
      var url = root.URL.createObjectURL(blob);
      var a = root.document.createElement('a');
      a.href = url; a.download = filename;
      root.document.body.appendChild(a); a.click();
      root.document.body.removeChild(a);
      setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000);
    }
    return { xml: xml, filename: filename };
  }

  // Attach to window (browser) and module.exports (node test).
  root.OF_parseMismo34 = OF_parseMismo34;
  root.OF_exportMismo34 = OF_exportMismo34;
  // expose internals for the test harness only
  root.__OF_MISMO__ = {
    parseMismo34: parseMismo34,
    buildMismo34: buildMismo34,
    normalizeLoanRow: normalizeLoanRow,
    VERSION: PARSER_VERSION
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__OF_MISMO__;
    module.exports.OF_parseMismo34 = OF_parseMismo34;
    module.exports.OF_exportMismo34 = OF_exportMismo34;
  }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
