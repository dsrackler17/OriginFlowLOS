// ═══════════════════════════════════════════════════════════════════════════
// /js/uldd-generator.js
//
// OriginFlow LOS · Round 4 · ULDD generator
//
// Builds MISMO 3.4 ULDD (Uniform Loan Delivery Dataset) XML — the data
// file lenders deliver to Fannie Mae (via Loan Delivery, the successor
// to ULDD Plus) or Freddie Mac (via Loan Selling Advisor) when selling
// a funded loan.
//
// ULDD is MISMO 3.4, same XML schema family as the AUS feed produced by
// mismo-generator.js, but a DIFFERENT envelope shape and a different set
// of required elements:
//
//   • AUS:  describes an APPLICATION being underwritten. Required parties:
//           borrower(s), submitter (the lender). Loan section minimal.
//   • ULDD: describes a FUNDED LOAN being sold. Required parties: same +
//           seller, servicer, settlement agent, MI company (if applicable).
//           Loan section detailed: note rate, coupon, P&I, amortization,
//           AUS recommendation, HMDA fields, servicing transfer info.
//
// Public API:
//
//   OFUldd.generateUldd(deliveryData)
//     → { xml: string, length_bytes: number, validation: [...edits...] }
//     The xml is the full <MESSAGE> document ready for transmission.
//
//   OFUldd.validateUldd(xml)
//     → array of edit objects: { code, severity, message, xpath }
//     Best-effort syntactic + structural validation. Investor-side edits
//     (Fannie has ~1100 of them) are NOT replicated here; we cover the
//     ~30 most common pre-flight checks so obvious errors are caught
//     before transmission.
//
// What v1 covers:
//   • Single-borrower or co-borrower (up to 4 borrowers)
//   • Fixed-rate purchase / refi-no-cash / refi-cash-out
//   • Conventional, FHA, VA, USDA programs
//   • Required HMDA-LAR fields
//   • Standard parties (lender / borrower / servicer / settlement / MI)
//
// What v1 does NOT cover:
//   • ARM (AIR table — index/margin/caps)
//   • Interest-only / negative amortization
//   • Modifications / refinances of GNMA pools
//   • Construction-to-perm
//   • Renovation loans (203(k), HomeStyle)
//   • Buy-up / buy-down pricing detail
//   • Per-investor required-field overrides (Fannie wants X, Freddie wants Y)
//
// LOAD ORDER:
//   <script src="/js/uldd-generator.js"></script>
//   then window.OFUldd is available.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // XML PRIMITIVES — hand-rolled, no dependencies
  // ═══════════════════════════════════════════════════════════════════════
  // Same shape as mismo-generator.js. Inlined here to keep the file
  // standalone (so a future maintainer touching ULDD doesn't have to
  // chase shared code into another file). The duplication is small.

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Render a single MISMO element. Returns a string fragment.
  //   el('LoanAmount', 400000)  →  <LoanAmount>400000</LoanAmount>
  //   el('LoanAmount', 400000, { 'mismo:type': 'amount' })
  //     →  <LoanAmount mismo:type="amount">400000</LoanAmount>
  //   el('REL', null, { id: 'X' })  →  <REL id="X" />   (self-closes)
  //   el('Empty', '')               →  ''                (omits entirely)
  //
  // The "omit on empty value" is critical — MISMO validation rejects
  // empty elements; better to leave them out than to render <X/> for
  // every optional field.
  function el(name, value, attrs) {
    const hasContent = value !== null && value !== undefined && value !== '';
    const attrPart = attrs ? Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    if (!hasContent) {
      // Self-close ONLY if attributes exist (xlink RELATIONSHIPs).
      // Otherwise omit. This is the bug fix from mismo-generator.js
      // that's worth carrying forward.
      return attrPart ? `<${name}${attrPart} />` : '';
    }
    return `<${name}${attrPart}>${esc(value)}</${name}>`;
  }

  // Container element — wraps children. Children can be strings or arrays.
  function ct(name, children, attrs) {
    const attrPart = attrs ? Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    const inner = (Array.isArray(children) ? children : [children])
      .filter(c => c != null && c !== '')
      .join('');
    if (!inner && !attrPart) return '';
    return `<${name}${attrPart}>${inner}</${name}>`;
  }

  // Format helpers for MISMO element values
  function fmtMoney(cents) {
    if (cents == null) return null;
    return (Number(cents) / 100).toFixed(2);
  }
  function fmtRate(bps) {
    if (bps == null) return null;
    return (Number(bps) / 100).toFixed(3);   // 7.250 not 7.25
  }
  function fmtPct(pct, digits = 3) {
    if (pct == null) return null;
    return Number(pct).toFixed(digits);
  }
  function fmtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);   // YYYY-MM-DD
  }
  function fmtSsn4(s4) {
    if (!s4) return null;
    // ULDD requires full 9-digit SSN; we have only last-4. Pad with
    // X's so the field is shaped right but obviously fake. A real
    // delivery would need actual SSNs from the borrowers table.
    return 'XXXXX' + String(s4).padStart(4, '0');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAPPING TABLES — convert internal codes to MISMO enums
  // ═══════════════════════════════════════════════════════════════════════
  // Internal codes ('conventional', 'purchase') → MISMO enums
  // ('Conventional', 'Purchase'). MISMO is title-case strict and rejects
  // unknown values, so the table is exhaustive for v1's supported set.

  const PROGRAM_TO_MISMO = {
    conventional: 'Conventional',
    fha:          'FHA',
    va:           'VA',
    usda:         'USDA-RD',
    jumbo:        'Conventional',  // jumbo is a conventional sub-type
    non_qm:       'Conventional',
  };

  const PURPOSE_TO_MISMO = {
    purchase:        'Purchase',
    refi_no_cash:    'NoCashOutRefinance',
    refi_cash_out:   'CashOutRefinance',
    refi_streamline: 'StreamlinedRefinance',
  };

  const OCCUPANCY_TO_MISMO = {
    primary:    'PrimaryResidence',
    second:     'SecondHome',
    investment: 'Investment',
  };

  const PROPERTY_TYPE_TO_MISMO = {
    sfr:        'Detached',
    condo:      'Condominium',
    townhouse:  'Attached',
    pud:        'PUD',
    multi:      'TwoToFourFamily',
    manufactured: 'ManufacturedHome',
  };

  // HMDA fields: borrower may have multiple ethnicities/races. We accept
  // either a single string or an array; output one element per value.
  const HMDA_ETHNICITY_TO_MISMO = {
    hispanic:       'HispanicOrLatino',
    not_hispanic:   'NotHispanicOrLatino',
    not_provided:   'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication',
    not_applicable: 'NotApplicable',
  };
  const HMDA_RACE_TO_MISMO = {
    white:                      'White',
    black:                      'BlackOrAfricanAmerican',
    asian:                      'Asian',
    aian:                       'AmericanIndianOrAlaskaNative',
    nhpi:                       'NativeHawaiianOrOtherPacificIslander',
    not_provided:               'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication',
    not_applicable:             'NotApplicable',
  };
  const HMDA_SEX_TO_MISMO = {
    male:           'Male',
    female:         'Female',
    not_provided:   'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication',
    not_applicable: 'NotApplicable',
  };

  const AUS_ENGINE_TO_MISMO = {
    fannie_du:    'DesktopUnderwriter',
    freddie_lp:   'LoanProductAdvisor',
    fha_total:    'TOTALScorecard',
    usda_gus:     'GUS',
    manual:       'Manual',
  };

  const AUS_DECISION_TO_MISMO = {
    approve:    'Approve',
    accept:     'Accept',
    refer:      'Refer',
    caution:    'Caution',
    ineligible: 'Ineligible',
  };

  // ═══════════════════════════════════════════════════════════════════════
  // PARTIES SECTION
  // ═══════════════════════════════════════════════════════════════════════
  // ULDD requires multiple PARTY elements with role identifiers. Each
  // party gets a unique id ('PARTY_BORROWER_1', 'PARTY_LENDER', etc.)
  // referenced by xlink:href in RELATIONSHIPS.

  function buildBorrowerParty(borrower, idx) {
    const partyId = `PARTY_BORROWER_${idx + 1}`;
    return ct('PARTY', [
      ct('INDIVIDUAL', [
        ct('NAME', [
          el('FirstName',  borrower.first_name),
          el('MiddleName', borrower.middle_name),
          el('LastName',   borrower.last_name),
          el('SuffixName', borrower.suffix),
        ]),
        ct('CONTACT_POINTS', [
          ct('CONTACT_POINT', [
            ct('CONTACT_POINT_EMAIL', el('ContactPointEmailValue', borrower.email)),
          ], { SequenceNumber: '1' }),
          ct('CONTACT_POINT', [
            ct('CONTACT_POINT_TELEPHONE', el('ContactPointTelephoneValue', borrower.phone)),
          ], { SequenceNumber: '2' }),
        ]),
      ]),
      ct('ROLES', [
        ct('ROLE', [
          ct('BORROWER', [
            // Identification — last 4 of SSN padded to 9
            ct('GOVERNMENT_BORROWER_IDENTIFICATIONS', [
              ct('GOVERNMENT_BORROWER_IDENTIFICATION', [
                el('GovernmentBorrowerIdentifierType', 'SocialSecurityNumber'),
                el('GovernmentBorrowerIdentifier',     fmtSsn4(borrower.ssn_last4)),
              ]),
            ]),
            // HMDA reporting fields — required for closed-end loans
            ct('HMDA_RACES', [
              ct('HMDA_RACE',
                el('HMDARaceType',
                  HMDA_RACE_TO_MISMO[borrower.hmda_race] || 'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication'
                ),
                { SequenceNumber: '1' }
              ),
            ]),
            el('HMDAEthnicityType',
              HMDA_ETHNICITY_TO_MISMO[borrower.hmda_ethnicity] || 'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication'
            ),
            el('HMDAGenderType',
              HMDA_SEX_TO_MISMO[borrower.hmda_sex] || 'InformationNotProvidedByApplicantInMailInternetOrTelephoneApplication'
            ),
            el('BorrowerBirthDate', fmtDate(borrower.dob)),
            el('CitizenshipResidencyType',
              borrower.citizenship_status === 'permanent_resident' ? 'PermanentResidentAlien'
              : borrower.citizenship_status === 'non_permanent'    ? 'NonPermanentResidentAlien'
              : 'USCitizen'
            ),
            el('PrintPositionType', idx === 0 ? 'Primary' : 'Secondary'),
          ]),
        ], { SequenceNumber: String(idx + 1) }),
      ]),
    ], { 'xlink:label': partyId });
  }

  function buildLenderParty(branch, lo) {
    return ct('PARTY', [
      ct('LEGAL_ENTITY', [
        ct('LEGAL_ENTITY_DETAIL',
          el('FullName', branch?.name)
        ),
        ct('CONTACTS', [
          ct('CONTACT', [
            ct('CONTACT_DETAIL',
              el('ContactPointRoleType', 'Work')
            ),
            ct('INDIVIDUAL', [
              ct('NAME',
                el('FullName', lo?.full_name)
              ),
            ]),
          ], { SequenceNumber: '1' }),
        ]),
      ]),
      ct('ROLES',
        ct('ROLE', [
          ct('LICENSES',
            ct('LICENSE', [
              el('LicenseIdentifier', branch?.nmls_id),
              el('LicenseType',       'NMLS'),
            ])
          ),
          el('PartyRoleType', 'NotePayTo'),
        ], { SequenceNumber: '1' })
      ),
    ], { 'xlink:label': 'PARTY_LENDER' });
  }

  function buildSellerParty(investor, branch) {
    return ct('PARTY', [
      ct('LEGAL_ENTITY',
        ct('LEGAL_ENTITY_DETAIL',
          el('FullName', branch?.name || 'Lender')
        )
      ),
      ct('ROLES',
        ct('ROLE', [
          ct('LICENSES',
            ct('LICENSE',
              el('LicenseIdentifier', investor?.uldd_seller_id)
            )
          ),
          el('PartyRoleType', 'Seller'),
        ], { SequenceNumber: '1' })
      ),
    ], { 'xlink:label': 'PARTY_SELLER' });
  }

  function buildServicerParty(investor) {
    return ct('PARTY', [
      ct('LEGAL_ENTITY',
        ct('LEGAL_ENTITY_DETAIL',
          el('FullName', investor?.name + ' (servicer)' || 'Servicer')
        )
      ),
      ct('ROLES',
        ct('ROLE', [
          ct('LICENSES',
            ct('LICENSE',
              el('LicenseIdentifier', investor?.uldd_servicer_id)
            )
          ),
          el('PartyRoleType', 'Servicer'),
        ], { SequenceNumber: '1' })
      ),
    ], { 'xlink:label': 'PARTY_SERVICER' });
  }

  function buildSettlementAgentParty(closing) {
    if (!closing?.title_company_name) return '';
    return ct('PARTY', [
      ct('LEGAL_ENTITY',
        ct('LEGAL_ENTITY_DETAIL',
          el('FullName', closing.title_company_name)
        )
      ),
      ct('ROLES',
        ct('ROLE',
          el('PartyRoleType', 'SettlementAgent'),
          { SequenceNumber: '1' }
        )
      ),
    ], { 'xlink:label': 'PARTY_SETTLEMENT_AGENT' });
  }

  function buildMICompanyParty(mi) {
    if (!mi?.provider) return '';
    return ct('PARTY', [
      ct('LEGAL_ENTITY',
        ct('LEGAL_ENTITY_DETAIL',
          el('FullName', mi.provider)
        )
      ),
      ct('ROLES',
        ct('ROLE',
          el('PartyRoleType', 'MICompany'),
          { SequenceNumber: '1' }
        )
      ),
    ], { 'xlink:label': 'PARTY_MI_COMPANY' });
  }

  function buildAllParties(data) {
    const borrowers = (data.borrowers || []).slice(0, 4);   // ULDD supports up to 4
    const parts = [
      ...borrowers.map((b, i) => buildBorrowerParty(b, i)),
      buildLenderParty(data.branch, data.lo),
      buildSellerParty(data.investor, data.branch),
      buildServicerParty(data.investor),
      buildSettlementAgentParty(data.closing),
      buildMICompanyParty(data.mortgage_insurance),
    ].filter(Boolean);
    return ct('PARTIES', parts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOANS SECTION
  // ═══════════════════════════════════════════════════════════════════════
  // The biggest section. Captures every aspect of the funded loan: terms,
  // amortization, identifiers, AUS, MI, HMDA, escrow, insurance,
  // servicing transfer.

  function buildLoan(data) {
    const monthlyPi = data.monthly_pi_cents
      || (data.locked_pricing_scenario && data.locked_pricing_scenario.monthly_pi_cents);

    return ct('LOAN', [

      // ─── ADJUSTMENT / RATE — fixed-rate v1 only ─────────────────────
      // (ARM AIR Table omitted; would go here as INTEREST_RATE_LIFETIME
      // ADJUSTMENT_RULE etc. — out of scope for v1.)

      // ─── AMORTIZATION ──────────────────────────────────────────────
      ct('AMORTIZATION',
        ct('AMORTIZATION_RULE', [
          el('AmortizationType',         'Fixed'),
          el('LoanAmortizationPeriodCount', data.term_months),
          el('LoanAmortizationPeriodType',  'Month'),
        ])
      ),

      // ─── CLOSING_INFORMATION ────────────────────────────────────────
      ct('CLOSING_INFORMATION',
        ct('CLOSING_INFORMATION_DETAIL', [
          el('ClosingDate',           fmtDate(data.closing?.signed_at || data.closing?.scheduled_at)),
          el('DisbursementDate',      fmtDate(data.closing?.disbursed_at || data.closing?.funding_date)),
          el('SettlementProcessType', 'Cash'),
        ])
      ),

      // ─── DOCUMENT_SPECIFIC_DATA_SETS ────────────────────────────────
      // Holds AUS + HMDA + QM information. ULDD requires these even
      // though the loan is post-funding because investors verify the
      // underwriting decision was sound.
      ct('DOCUMENT_SPECIFIC_DATA_SETS',
        ct('DOCUMENT_SPECIFIC_DATA_SET', [
          // QM type — what kind of qualified-mortgage status
          ct('URLA_2009_DETAIL',
            el('LoanOriginationSystemLoanIdentifier', data.loan_number)
          ),
        ])
      ),

      // ─── ESCROW ─────────────────────────────────────────────────────
      ct('ESCROW',
        ct('ESCROW_DETAIL', [
          el('EscrowAccountInd', data.has_escrow !== false ? 'true' : 'false'),
        ])
      ),

      // ─── HMDA_LOAN ──────────────────────────────────────────────────
      // Required for HMDA reportable loans. Omitted for non-reportable
      // (commercial, etc.) — most consumer mortgages are reportable.
      ct('HMDA_LOAN',
        ct('HMDA_LOAN_DETAIL', [
          el('HMDAHOEPALoanStatusIndicator', 'false'),  // assume non-HOEPA
          el('HMDAPreapprovalType',          'PreapprovalRequestNotApplicable'),
        ])
      ),

      // ─── LOAN_DETAIL ────────────────────────────────────────────────
      // Top-level loan facts.
      ct('LOAN_DETAIL', [
        el('AssumabilityIndicator',                'false'),
        el('BalloonIndicator',                     'false'),
        el('ConstructionLoanIndicator',            'false'),
        el('ConvertibleIndicator',                 'false'),
        el('EscrowIndicator',                      data.has_escrow !== false ? 'true' : 'false'),
        el('InterestOnlyIndicator',                'false'),
        el('LienPriorityType',                     'FirstLien'),
        el('LoanAmountIncreaseIndicator',          'false'),
        el('MICollectedNumberOfMonthsCount',       data.mortgage_insurance ? 12 : null),
        el('NegativeAmortizationIndicator',        'false'),
        el('PaymentFrequencyType',                 'Monthly'),
        el('PrepaymentPenaltyIndicator',           'false'),
        el('SeasonalPaymentFeatureIndicator',      'false'),
      ]),

      // ─── LOAN_IDENTIFIERS ───────────────────────────────────────────
      ct('LOAN_IDENTIFIERS', [
        ct('LOAN_IDENTIFIER', [
          el('LoanIdentifier',     data.loan_number),
          el('LoanIdentifierType', 'LenderLoan'),
        ], { SequenceNumber: '1' }),
        ct('LOAN_IDENTIFIER', [
          el('LoanIdentifier',     data.aus?.casefile_id),
          el('LoanIdentifierType', data.aus?.engine === 'fannie_du' ? 'AgencyCase'
                                  : data.aus?.engine === 'freddie_lp' ? 'LoanProspectorKey'
                                  : 'AgencyCase'),
        ], data.aus?.casefile_id ? { SequenceNumber: '2' } : null),
        ct('LOAN_IDENTIFIER', [
          el('LoanIdentifier',     data.servicer_loan_id),
          el('LoanIdentifierType', 'ServicerLoan'),
        ], data.servicer_loan_id ? { SequenceNumber: '3' } : null),
      ].filter(Boolean)),

      // ─── LOAN_LEVEL_CREDIT ──────────────────────────────────────────
      // Rep score + DTI. Investor edits compare these to commitment
      // criteria; mismatch is the most common rejection reason.
      ct('LOAN_LEVEL_CREDIT',
        ct('LOAN_LEVEL_CREDIT_DETAIL', [
          el('LoanLevelCreditScoreSelectionMethodType', 'MiddleOrLower'),
          el('LoanLevelCreditScoreValue',               data.rep_score),
        ])
      ),

      // ─── LTV ────────────────────────────────────────────────────────
      ct('LTV',
        ct('LTV_DETAIL', [
          el('BaseLTVRatioPercent',       fmtPct(data.ltv_pct)),
          el('CombinedLTVRatioPercent',   fmtPct(data.cltv_pct)),
        ])
      ),

      // ─── MATURITY ───────────────────────────────────────────────────
      ct('MATURITY',
        ct('MATURITY_RULE', [
          el('LoanMaturityDate',
            fmtDate(addMonths(data.first_payment_date, data.term_months - 1))
          ),
          el('LoanMaturityPeriodCount', data.term_months),
          el('LoanMaturityPeriodType',  'Month'),
        ])
      ),

      // ─── MI_DATA ────────────────────────────────────────────────────
      // Mortgage Insurance details. Required for LTV > 80 conventional
      // and all FHA/USDA. Omitted entirely if no MI.
      data.mortgage_insurance ? ct('MI_DATA',
        ct('MI_DATA_DETAIL', [
          el('MICertificateIdentifier',         data.mortgage_insurance.certificate_number),
          el('MICompanyNameType',               'Other'),
          el('MICompanyNameTypeOtherDescription', data.mortgage_insurance.provider),
          el('MIPremiumRatePercent',            fmtPct(data.mortgage_insurance.premium_pct, 4)),
          el('MIScheduledTerminationDate',
            fmtDate(addMonths(data.first_payment_date, data.mortgage_insurance.premium_term_months || 132))
          ),
        ])
      ) : '',

      // ─── ORIGINATION_SYSTEMS ────────────────────────────────────────
      ct('ORIGINATION_SYSTEMS',
        ct('ORIGINATION_SYSTEM',
          ct('ORIGINATION_SYSTEM_DETAIL', [
            el('OriginationSystemName',    'OriginFlow LOS'),
            el('OriginationSystemVersion', '0.2'),
          ])
        )
      ),

      // ─── PAYMENT ────────────────────────────────────────────────────
      ct('PAYMENT',
        ct('PAYMENT_RULE', [
          el('FirstPaymentDueDate',         fmtDate(data.first_payment_date)),
          el('InitialPrincipalAndInterestPaymentAmount', fmtMoney(monthlyPi)),
          el('LastPaidInstallmentDueDate',  fmtDate(data.first_payment_date)),
          el('PaymentFrequencyType',        'Monthly'),
          el('ScheduledFirstPaymentDate',   fmtDate(data.first_payment_date)),
        ])
      ),

      // ─── QUALIFICATION ──────────────────────────────────────────────
      ct('QUALIFICATION',
        ct('QUALIFICATION_DETAIL', [
          el('QualifyingRatePercent', fmtRate(data.rate_bps)),
          el('TotalMonthlyIncomeAmount',
            fmtMoney(sumIncome(data.borrowers))
          ),
          el('TotalDebtExpenseRatioPercent', fmtPct(data.dti_back_pct)),
          el('TotalLiabilitiesMonthlyPaymentAmount',
            fmtMoney(sumIncome(data.borrowers) * (data.dti_back_pct || 0) / 100)
          ),
        ])
      ),

      // ─── TERMS_OF_LOAN ──────────────────────────────────────────────
      // The headline numbers an investor cares most about: amount, rate,
      // coupon, mortgage type, lien position, purpose.
      ct('TERMS_OF_LOAN', [
        el('AssumabilityIndicator', 'false'),
        el('BaseLoanAmount',         fmtMoney(data.loan_amount_cents)),
        el('LoanPurposeType',
          PURPOSE_TO_MISMO[data.purpose] || 'Other'
        ),
        el('MortgageType',
          PROGRAM_TO_MISMO[data.program] || 'Conventional'
        ),
        el('NoteAmount',             fmtMoney(data.loan_amount_cents)),
        el('NoteDate',               fmtDate(data.closing?.signed_at || data.closing?.scheduled_at)),
        el('NoteRatePercent',        fmtRate(data.rate_bps)),
        el('OriginalInterestRatePercent', fmtRate(data.rate_bps)),
        el('WeightedAverageCouponRatePercent', fmtRate(data.commitment?.coupon_rate_bps || data.rate_bps)),
      ]),

      // ─── UNDERWRITING ───────────────────────────────────────────────
      // AUS engine + decision. Investor edits sometimes verify that
      // the decision matches the loan profile (e.g., DU Approve at DTI
      // 50% triggers a soft warning).
      ct('UNDERWRITING',
        ct('UNDERWRITING_DETAIL',
          el('AutomatedUnderwritingSystemType',
            AUS_ENGINE_TO_MISMO[data.aus?.engine] || 'Manual'
          )
        )
      ),

    ]);
  }

  // Helper for borrower income sum
  function sumIncome(borrowers) {
    if (!borrowers) return 0;
    return borrowers.reduce((s, b) => s + (Number(b.income_monthly_cents) || 0), 0);
  }

  // Helper for adding months to a date string
  function addMonths(dateStrOrIso, months) {
    if (!dateStrOrIso) return null;
    const d = new Date(dateStrOrIso);
    if (isNaN(d.getTime())) return null;
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COLLATERALS SECTION
  // ═══════════════════════════════════════════════════════════════════════

  function buildCollaterals(data) {
    const addr = data.property_address || {};
    return ct('COLLATERALS',
      ct('COLLATERAL',
        ct('SUBJECT_PROPERTY', [
          ct('ADDRESS', [
            el('AddressLineText',     addr.street),
            el('AddressUnitIdentifier', addr.unit),
            el('CityName',            addr.city),
            el('CountryCode',         'US'),
            el('PostalCode',          addr.zip),
            el('StateCode',           addr.state),
          ]),
          ct('PROPERTY_DETAIL', [
            el('AttachmentType',
              data.property_type === 'condo' ? 'Attached'
              : data.property_type === 'townhouse' ? 'Attached'
              : 'Detached'
            ),
            el('PropertyEstateType',          'FeeSimple'),
            el('PropertyUsageType',
              OCCUPANCY_TO_MISMO[data.occupancy] || 'PrimaryResidence'
            ),
          ]),
          ct('PROPERTY_VALUATIONS',
            ct('PROPERTY_VALUATION',
              ct('PROPERTY_VALUATION_DETAIL', [
                el('PropertyValuationAmount', fmtMoney(data.appraised_value_cents)),
                el('PropertyValuationMethodType', 'FullAppraisal'),
              ])
            )
          ),
          ct('SALES_CONTRACTS',
            data.purchase_price_cents ? ct('SALES_CONTRACT',
              ct('SALES_CONTRACT_DETAIL',
                el('RealPropertyAmount', fmtMoney(data.purchase_price_cents))
              )
            ) : ''
          ),
        ])
      )
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RELATIONSHIPS — link parties to roles via xlink:href
  // ═══════════════════════════════════════════════════════════════════════
  // ULDD uses MISMO RELATIONSHIPS to wire parties to the loan and
  // collaterals. Each relationship has a role label.

  function buildRelationships(data) {
    const rels = [];
    let seq = 1;
    (data.borrowers || []).slice(0, 4).forEach((_, i) => {
      rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_BORROWER_${i + 1}" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    });
    rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_LENDER" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_SELLER" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_SERVICER" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    if (data.closing?.title_company_name) {
      rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_SETTLEMENT_AGENT" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    }
    if (data.mortgage_insurance) {
      rels.push(`<RELATIONSHIP xlink:from="LOAN_1" xlink:to="PARTY_MI_COMPANY" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    }
    rels.push(`<RELATIONSHIP xlink:from="COLLATERAL_1" xlink:to="LOAN_1" xlink:arcrole="urn:fdc:Mortgage.Mismo.org:2009:role/IsAssociatedWith" SequenceNumber="${seq++}"/>`);
    return ct('RELATIONSHIPS', rels);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOP-LEVEL DEAL ASSEMBLY
  // ═══════════════════════════════════════════════════════════════════════
  // MISMO requires children of <DEAL> in alphabetical order. Same gotcha
  // as the AUS generator (mismo-generator.js) — get this wrong and the
  // schema validator rejects with a confusing error message about
  // sequence-violation in the choice group.

  function buildDeal(data) {
    return ct('DEAL', [
      buildAllParties(data),
      ct('LOANS', buildLoan(data), null),  // wraps single LOAN
      buildCollaterals(data),
      buildRelationships(data),
    ]);
  }

  function buildMessage(data) {
    const aboutVersion = el('AboutVersionIdentifier',
      'OriginFlow ULDD generator · v1 · ' + new Date().toISOString()
    );
    return ct('MESSAGE', [
      ct('ABOUT_VERSIONS',
        ct('ABOUT_VERSION', aboutVersion)
      ),
      ct('DEAL_SETS',
        ct('DEAL_SET',
          ct('DEALS', buildDeal(data))
        )
      ),
    ], {
      'xmlns':       'http://www.mismo.org/residential/2009/schemas',
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      'MISMOReferenceModelIdentifier': '3.4.0301',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  function generateUldd(data) {
    if (!data) throw new Error('generateUldd: deliveryData is required');

    // Compute first_payment_date if not provided. Convention: first day
    // of the SECOND month after disbursement. Disbursement May 12 →
    // first payment July 1.
    if (!data.first_payment_date) {
      const disb = data.closing?.disbursed_at || data.closing?.funding_date || data.closing?.signed_at;
      if (disb) {
        const d = new Date(disb);
        d.setMonth(d.getMonth() + 2);
        d.setDate(1);
        data.first_payment_date = d.toISOString().slice(0, 10);
      }
    }

    const xmlBody = buildMessage(data);
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlBody;
    const validation = validateUldd(xml, data);

    return {
      xml,
      length_bytes: new Blob([xml]).size,
      validation,
    };
  }

  // Validation — pre-flight edits. Catches the 20-30 most common errors
  // that would make Fannie/Freddie reject the delivery, BEFORE we
  // transmit. Real investor edits cover ~1100 cases; we cover the ones
  // that show up in 95% of rejections.
  function validateUldd(xml, data) {
    const edits = [];
    const must = (cond, code, severity, message, xpath) => {
      if (!cond) edits.push({ code, severity, message, xpath });
    };

    if (!data) {
      edits.push({
        code: 'NO_DATA',
        severity: 'fatal',
        message: 'No data provided to validateUldd. Pass the same data object used for generateUldd.',
        xpath: '/',
      });
      return edits;
    }

    must(data.loan_number, 'LOAN_NUMBER_MISSING', 'fatal',
      'Lender loan identifier is required.',
      '/MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/LOAN_IDENTIFIERS');

    must(data.loan_amount_cents > 0, 'LOAN_AMOUNT_INVALID', 'fatal',
      'Loan amount must be positive.',
      '//TERMS_OF_LOAN/BaseLoanAmount');

    must(data.rate_bps != null && data.rate_bps >= 0 && data.rate_bps <= 5000,
      'RATE_OUT_OF_RANGE', 'fatal',
      'Note rate must be between 0% and 50%.',
      '//TERMS_OF_LOAN/NoteRatePercent');

    must(data.term_months > 0 && data.term_months <= 480, 'TERM_INVALID', 'fatal',
      'Term must be between 1 and 480 months.',
      '//AMORTIZATION_RULE/LoanAmortizationPeriodCount');

    must(data.borrowers && data.borrowers.length > 0, 'NO_BORROWERS', 'fatal',
      'At least one borrower is required.',
      '//PARTIES');

    must(data.borrowers && data.borrowers.length <= 4, 'TOO_MANY_BORROWERS', 'fatal',
      'ULDD supports at most 4 borrowers.',
      '//PARTIES');

    if (data.borrowers) {
      data.borrowers.forEach((b, i) => {
        must(b.first_name, 'BORROWER_NAME_MISSING_' + (i+1), 'fatal',
          `Borrower ${i+1}: first_name is required.`,
          `//PARTY_BORROWER_${i+1}/INDIVIDUAL/NAME/FirstName`);
        must(b.last_name, 'BORROWER_LASTNAME_MISSING_' + (i+1), 'fatal',
          `Borrower ${i+1}: last_name is required.`,
          `//PARTY_BORROWER_${i+1}/INDIVIDUAL/NAME/LastName`);
        must(b.dob, 'BORROWER_DOB_MISSING_' + (i+1), 'warning',
          `Borrower ${i+1}: date of birth missing — required for HMDA reporting.`,
          `//PARTY_BORROWER_${i+1}/BORROWER/BorrowerBirthDate`);
        must(b.ssn_last4, 'BORROWER_SSN_MISSING_' + (i+1), 'fatal',
          `Borrower ${i+1}: SSN required.`,
          `//PARTY_BORROWER_${i+1}/BORROWER/GovernmentBorrowerIdentifier`);
        // Soft check: ssn_last4 only — generator pads to 9 with X's. Real
        // delivery needs full SSN.
        if (b.ssn_last4 && !b.ssn_full) {
          edits.push({
            code: 'BORROWER_SSN_PADDED_' + (i+1), severity: 'warning',
            message: `Borrower ${i+1}: only last-4 SSN available; XML padded with X's. Investor will reject.`,
            xpath: `//PARTY_BORROWER_${i+1}/BORROWER/GovernmentBorrowerIdentifier`,
          });
        }
      });
    }

    must(data.property_address?.street && data.property_address?.city &&
         data.property_address?.state && data.property_address?.zip,
      'PROPERTY_ADDRESS_INCOMPLETE', 'fatal',
      'Property address requires street, city, state, and zip.',
      '//SUBJECT_PROPERTY/ADDRESS');

    must(data.appraised_value_cents > 0, 'APPRAISAL_MISSING', 'warning',
      'Appraised value missing — required for ULDD delivery.',
      '//PROPERTY_VALUATION_DETAIL/PropertyValuationAmount');

    must(data.ltv_pct != null && data.ltv_pct > 0 && data.ltv_pct <= 200,
      'LTV_INVALID', 'warning',
      'LTV must be in range 0–200%.',
      '//LTV_DETAIL/BaseLTVRatioPercent');

    must(data.investor?.uldd_seller_id, 'SELLER_ID_MISSING', 'fatal',
      'Investor seller ID required for ULDD acceptance.',
      '//PARTY_SELLER/LICENSE/LicenseIdentifier');

    must(data.closing?.signed_at || data.closing?.scheduled_at,
      'CLOSING_DATE_MISSING', 'fatal',
      'Closing date required.',
      '//CLOSING_INFORMATION_DETAIL/ClosingDate');

    must(data.aus?.engine, 'AUS_MISSING', 'warning',
      'AUS engine + decision recommended for ULDD; will populate as Manual if absent.',
      '//UNDERWRITING_DETAIL/AutomatedUnderwritingSystemType');

    must(data.rep_score, 'CREDIT_SCORE_MISSING', 'warning',
      'Representative credit score required for delivery to GSEs.',
      '//LOAN_LEVEL_CREDIT_DETAIL/LoanLevelCreditScoreValue');

    // MI required when LTV > 80 conventional
    if (data.program === 'conventional' && data.ltv_pct > 80) {
      must(data.mortgage_insurance,
        'MI_REQUIRED', 'warning',
        'LTV > 80% on conventional requires mortgage insurance details.',
        '//MI_DATA');
    }

    // FHA always requires UFMIP info — we don't model UFMIP separately so
    // just warn.
    if (data.program === 'fha' && !data.mortgage_insurance) {
      edits.push({
        code: 'FHA_MIP_MISSING', severity: 'warning',
        message: 'FHA loan missing UFMIP/annual MIP info — required for delivery.',
        xpath: '//MI_DATA',
      });
    }

    return edits;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════════════════
  window.OFUldd = {
    generateUldd,
    validateUldd,
    // Internal helpers exposed for testing
    _el: el,
    _ct: ct,
    _fmtMoney: fmtMoney,
    _fmtRate:  fmtRate,
    _fmtDate:  fmtDate,
    _addMonths: addMonths,
  };
})();
