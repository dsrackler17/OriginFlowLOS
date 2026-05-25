// ═══════════════════════════════════════════════════════════════════════════
// js/tabs/closing.js — CLOSING tab module for loan.html
//
// Registers on window.OF.tabs.closing so loan.html's dispatcher picks it up
// without touching the 3,500-line core (the dispatcher checks window.OF.tabs
// BEFORE its built-in switch — see renderActiveTabAsync()).
//
// Contract:  window.OF.tabs.<name> = async (loan, me, supa, container) => {}
//
// Backed by migrations 029 (closing core) + 030 (compliance) + 031 (OFAC gate):
//   tables : settlement_agents, title_commitments, closing_protection_letters,
//            wire_instructions, closing_appointments, settlement_statements,
//            funding_events, ofac_screenings, cip_verifications,
//            adverse_action_notices
//   rpcs   : verify_wire(p_wire_id, p_callback_phone_source)
//            record_funding(p_loan_id, p_amount_cents)
//
// Every query fails OPEN: a missing table contributes an empty state, never
// an error that breaks the tab. The RPCs are the hard gates; the UI only
// guides toward readiness. Reuses loan.html's existing CSS classes
// (docs-summary, disc-panel, disc-status-pill, btn, …) so it needs no new CSS.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  window.OF = window.OF || {};
  window.OF.tabs = window.OF.tabs || {};

  // ─── Self-contained helpers (don't assume of-helpers.js global names) ──
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cents = (c) => (c == null ? '—'
    : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtDate = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (_) { return String(d); }
  };
  const ago = (iso) => {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return fmtDate(iso);
  };
  // Fail-open single/array fetch: returns [] (or null) instead of throwing.
  async function tryRows(supa, table, build) {
    try {
      let q = supa.from(table).select('*').eq('loan_id', _loanId);
      if (build) q = build(q);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    } catch (_) { return []; }
  }

  let _loanId = null;

  window.OF.tabs.closing = async function (loan, me, supa, container) {
    _loanId = loan.id;
    container.innerHTML = `<div class="disc-loading"><div class="disc-loading-spinner"></div>Loading closing desk…</div>`;

    // ─── Fetch everything in parallel; each fails open ───────────────────
    const [agents, titles, cpls, wires, appts, stmts, fundings, ofac, cip, aan] = await Promise.all([
      (async () => { // settlement_agents is branch-scoped, not loan-scoped
        try {
          const { data, error } = await supa.from('settlement_agents')
            .select('*').eq('branch_id', loan.branch_id).eq('is_active', true)
            .order('verified_at', { ascending: false });
          if (error) throw error; return data || [];
        } catch (_) { return []; }
      })(),
      tryRows(supa, 'title_commitments', q => q.order('received_at', { ascending: false })),
      tryRows(supa, 'closing_protection_letters', q => q.order('created_at', { ascending: false })),
      tryRows(supa, 'wire_instructions', q => q.order('created_at', { ascending: false })),
      tryRows(supa, 'closing_appointments', q => q.order('scheduled_at', { ascending: false })),
      tryRows(supa, 'settlement_statements', q => q.order('created_at', { ascending: false })),
      tryRows(supa, 'funding_events', q => q.order('occurred_at', { ascending: false })),
      tryRows(supa, 'ofac_screenings', q => q.order('screened_at', { ascending: false })),
      tryRows(supa, 'cip_verifications', q => q.order('created_at', { ascending: false })),
      tryRows(supa, 'adverse_action_notices', q => q.order('created_at', { ascending: false })),
    ]);

    // ─── Derive readiness ────────────────────────────────────────────────
    const title = titles[0] || null;
    const cpl = cpls[0] || null;
    const appt = appts[0] || null;
    const stmt = stmts[0] || null;
    const verifiedWire = wires.find(w => w.status === 'verified') || null;
    const draftWire = wires.find(w => w.status !== 'verified') || null;
    const funded = fundings.some(f => f.event_type === 'funded') || loan.status === 'funded';

    const ofacHit = ofac.some(o => o.result === 'confirmed_hit');
    const ofacUnresolved = ofac.some(o => o.result === 'potential_match' && !o.resolved_by);
    const ofacClearRow = ofac.some(o => o.result === 'clear');
    const ofacState = ofacHit ? 'block' : ofacUnresolved ? 'block' : ofacClearRow ? 'ok' : 'todo';

    const cipRow = cip.find(c => c.status === 'verified') || cip[0] || null;
    const cipOk = !!cip.find(c => c.status === 'verified');

    const aanRow = aan[0] || null;
    const declined = String(loan.status || '').toLowerCase().includes('declin')
      || String(loan.status || '').toLowerCase().includes('denied');

    const wireReady = !!verifiedWire;
    const fundReady = wireReady && !ofacHit && !ofacUnresolved && cipOk && !funded;
    const fundAmount = (stmt && stmt.total_disbursed_cents) || (verifiedWire && verifiedWire.amount_cents) || null;

    // ─── Build HTML ──────────────────────────────────────────────────────
    const sp = (cls, txt) => `<span class="disc-status-pill ${cls}">${esc(txt)}</span>`;

    let html = '';

    // Readiness strip (reuse docs-summary)
    html += `
      <div class="docs-summary" style="grid-template-columns: repeat(5, 1fr);">
        <div class="docs-summary-cell">
          <div class="docs-summary-label">Wire</div>
          <div class="docs-summary-value ${wireReady ? 'green' : 'amber'}" style="font-size:1.05rem;">${wireReady ? 'VERIFIED' : (draftWire ? 'UNVERIFIED' : 'NONE')}</div>
          <div class="docs-summary-sub">two-person callback</div>
        </div>
        <div class="docs-summary-cell">
          <div class="docs-summary-label">OFAC</div>
          <div class="docs-summary-value ${ofacState === 'ok' ? 'green' : ofacState === 'block' ? '' : 'amber'}" style="font-size:1.05rem;${ofacState === 'block' ? 'color:var(--red);' : ''}">${ofacHit ? 'HIT' : ofacUnresolved ? 'REVIEW' : ofacClearRow ? 'CLEAR' : 'NOT RUN'}</div>
          <div class="docs-summary-sub">SDN screening</div>
        </div>
        <div class="docs-summary-cell">
          <div class="docs-summary-label">CIP / BSA</div>
          <div class="docs-summary-value ${cipOk ? 'green' : 'amber'}" style="font-size:1.05rem;">${cipOk ? 'VERIFIED' : 'PENDING'}</div>
          <div class="docs-summary-sub">identity verified</div>
        </div>
        <div class="docs-summary-cell">
          <div class="docs-summary-label">Cash to Close</div>
          <div class="docs-summary-value cyan" style="font-size:1.05rem;">${esc(stmt && stmt.cash_to_close_cents != null ? cents(stmt.cash_to_close_cents) : '—')}</div>
          <div class="docs-summary-sub">borrower</div>
        </div>
        <div class="docs-summary-cell">
          <div class="docs-summary-label">Status</div>
          <div class="docs-summary-value ${funded ? 'green' : ''}" style="font-size:1.05rem;">${funded ? 'FUNDED' : 'IN PROGRESS'}</div>
          <div class="docs-summary-sub">${esc(verifiedWire ? cents(fundAmount) + ' net' : 'pre-fund')}</div>
        </div>
      </div>
    `;

    // Sanctions hard block alert
    if (ofacHit || ofacUnresolved) {
      html += `
        <div class="disc-alert red">
          <span class="disc-alert-icon">!</span>
          <div class="disc-alert-body">
            <div class="disc-alert-title">${ofacHit ? 'Confirmed OFAC/SDN match — funding prohibited' : 'Unresolved potential OFAC match'}</div>
            <div class="disc-alert-sub">${ofacHit ? 'A confirmed sanctions hit blocks funding at the database layer (record_funding).' : 'Funding is blocked until an analyst dispositions the potential match (sets resolved_by).'}</div>
          </div>
        </div>
      `;
    }

    // Settlement Agent
    const agent = (verifiedWire && agents.find(a => a.id === verifiedWire.settlement_agent_id))
      || agents.find(a => a.verified_at) || agents[0] || null;
    html += panel('Settlement Agent',
      agent ? sp(agent.verified_at ? 'delivered' : 'pending', agent.verified_at ? 'verified' : 'unverified') : sp('na', 'none'),
      agent ? kv([
        ['Company', `<strong>${esc(agent.company_name)}</strong>`],
        ['Type', esc((agent.agent_type || '').replace(/_/g, ' '))],
        ['Contact', esc([agent.contact_name, agent.phone].filter(Boolean).join(' · ') || '—')],
        ['Callback verified', agent.verified_at ? `<span class="green">${esc(fmtDate(agent.verified_at))}</span>` : '<span class="amber">not yet</span>'],
      ]) : empty('No settlement agent on file. Add one in the branch settlement-agent directory; loan-level wires must reference a verified agent.', '13.0.8'));

    // Title Commitment
    html += panel('Title Commitment',
      title ? sp(title.status === 'cleared_to_close' ? 'delivered' : 'pending', (title.status || 'received').replace(/_/g, ' ')) : sp('na', 'none'),
      title ? kv([
        ['Commitment #', esc(title.commitment_number || '—')],
        ['Effective', `${esc(fmtDate(title.effective_date))} → ${esc(fmtDate(title.expiration_date))}`],
        ['Lender policy', esc(cents(title.lender_policy_cents))],
        ['Schedule B-I', reqSummary(title.requirements)],
        ['Schedule B-II', `${(Array.isArray(title.exceptions) ? title.exceptions.length : 0)} exception(s)`],
      ]) : empty('No title commitment received. Schedule A/B requirements and exceptions populate here once the commitment lands.', '13.0.10'));

    // CPL
    html += panel('Closing Protection Letter',
      cpl ? sp(cpl.status === 'received' ? 'delivered' : 'pending', cpl.status || 'received') : sp('na', 'none'),
      cpl ? kv([
        ['CPL #', esc(cpl.cpl_number || '—')],
        ['Issued by', esc(cpl.issued_by || '—')],
        ['Expires', esc(fmtDate(cpl.expiration_date))],
        ['Addressee', esc(cpl.addressee || '—')],
      ]) : empty('No CPL on file. Request from the title underwriter before closing.', '13.0.9'));

    // Wire Instructions — the anti-fraud surface
    html += `
      <div class="disc-panel">
        <div class="disc-panel-head">
          <span class="disc-panel-title">Wire Instructions ${verifiedWire ? sp('delivered', 'verified') : (draftWire ? sp('missing', 'unverified') : sp('na', 'none'))}</span>
        </div>
        <div class="disc-panel-body">
          <div class="disc-alert amber" style="margin-bottom:0.85rem;">
            <span class="disc-alert-icon">⚠</span>
            <div class="disc-alert-body">
              <div class="disc-alert-title">Wire-fraud control</div>
              <div class="disc-alert-sub">Two-person rule enforced server-side (verifier ≠ enterer). Callback must use an independently-sourced phone number — never one from the wire email.</div>
            </div>
          </div>
          ${renderWire(verifiedWire || draftWire)}
        </div>
      </div>
    `;

    // Closing Schedule
    html += panel('Closing Schedule',
      appt ? sp(appt.status === 'confirmed' || appt.status === 'completed' ? 'delivered' : 'pending', appt.status || 'tentative') : sp('na', 'none'),
      appt ? kv([
        ['CD delivered', appt.cd_delivered_at ? `<span class="green">${esc(fmtDate(appt.cd_delivered_at))}</span>` : '<span class="amber">pending</span>'],
        ['Signing', esc(fmtDate(appt.scheduled_at))],
        ['Method', esc(`${(appt.signing_method || '').replace(/_/g, ' ')} · ${(appt.closing_type || '')}`)],
        ['Disbursement', esc(fmtDate(appt.disbursement_date))],
      ]) : empty('No closing appointment scheduled. Set the signing date + method; the TRID 3-business-day clock keys off CD delivery.', '13.0.3'));

    // Settlement Statement
    html += panel('Settlement Statement',
      stmt ? sp(stmt.status === 'final' || stmt.status === 'disbursed' ? 'delivered' : 'pending', stmt.status || 'draft') : sp('na', 'none'),
      stmt ? kv([
        ['Total loan', esc(cents(stmt.total_loan_cents))],
        ['Total charges', esc(cents(stmt.total_charges_cents))],
        ['Cash to close', `<span class="accent">${esc(cents(stmt.cash_to_close_cents))}</span>`],
        ['Net disbursed', esc(cents(stmt.total_disbursed_cents))],
      ]) : empty('No settlement statement yet. Header + line items reconcile the CD; figures freeze at status=final.', '13.0.1'));

    // Compliance strip
    html += `
      <div class="disc-panel">
        <div class="disc-panel-head"><span class="disc-panel-title">Compliance Gate</span></div>
        <div class="disc-panel-body">
          <div class="disc-kv-grid">
            <span class="disc-kv-key">OFAC / SDN</span>
            <span class="disc-kv-val">${ofacHit ? '<span class="red">Confirmed hit — blocked</span>' : ofacUnresolved ? '<span class="amber">Potential match — review</span>' : ofacClearRow ? '<span class="green">Clear</span>' : '<span class="amber">Not screened</span>'}<span class="sub">${esc(ofac.length)} screening row(s)</span></span>

            <span class="disc-kv-key">CIP / BSA</span>
            <span class="disc-kv-val">${cipOk ? '<span class="green">Verified</span>' : '<span class="amber">Pending</span>'}${cipRow ? `<span class="sub">${[cipRow.name_verified && 'name', cipRow.dob_verified && 'dob', cipRow.address_verified && 'address', cipRow.id_number_verified && 'id'].filter(Boolean).join(' · ') || 'no elements'}</span>` : ''}</span>

            <span class="disc-kv-key">Adverse Action</span>
            <span class="disc-kv-val">${declined ? (aanRow && ['ready', 'sent'].includes(aanRow.status) ? '<span class="green">Reg B notice ' + esc(aanRow.status) + '</span>' : '<span class="red">Decline — notice not ready</span>') : '<span class="sub" style="color:var(--muted);">N/A — not a decline</span>'}</span>
          </div>
        </div>
      </div>
    `;

    // Fund action
    html += `
      <div class="disc-panel">
        <div class="disc-panel-head">
          <span class="disc-panel-title">Funding</span>
          <div class="disc-panel-actions">
            <button id="of-fund-btn" class="btn primary" ${fundReady ? '' : 'disabled'} title="${fundReady ? 'all gates green' : 'gates outstanding'}">▸ Record Funding</button>
          </div>
        </div>
        <div class="disc-panel-body">
          ${funded
            ? `<div class="disc-alert green"><span class="disc-alert-icon">✓</span><div class="disc-alert-body"><div class="disc-alert-title">Loan funded</div><div class="disc-alert-sub">${esc(fundings.length ? ago(fundings[0].occurred_at) : '')} · funding_event recorded, audit hash-chained.</div></div></div>`
            : `<div class="disc-kv-grid">
                 <span class="disc-kv-key">Verified wire</span><span class="disc-kv-val">${wireReady ? '<span class="green">yes</span>' : '<span class="red">required</span>'}</span>
                 <span class="disc-kv-key">OFAC clear</span><span class="disc-kv-val">${(!ofacHit && !ofacUnresolved) ? '<span class="green">yes</span>' : '<span class="red">blocked</span>'}</span>
                 <span class="disc-kv-key">CIP verified</span><span class="disc-kv-val">${cipOk ? '<span class="green">yes</span>' : '<span class="amber">required</span>'}</span>
                 <span class="disc-kv-key">Amount</span><span class="disc-kv-val">${esc(cents(fundAmount))}</span>
               </div>
               <div style="font-family:var(--mono);font-size:0.58rem;color:var(--muted);letter-spacing:0.04em;margin-top:0.75rem;">record_funding enforces these gates server-side (admin/closer only). The button mirrors them for guidance.</div>`}
        </div>
      </div>
    `;

    container.innerHTML = html;

    // ─── Wire interactions ───────────────────────────────────────────────
    const verifyBtn = container.querySelector('#of-verify-wire-btn');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async () => {
        const srcSel = container.querySelector('#of-cb-source');
        const src = srcSel ? srcSel.value : 'independent';
        if (src === 'from_email') { alert('Refused: callback must use an independently sourced phone number, never one from the wire email.'); return; }
        const w = draftWire || verifiedWire;
        if (!w) return;
        verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying…';
        try {
          const { data, error } = await supa.rpc('verify_wire', { p_wire_id: w.id, p_callback_phone_source: src });
          if (error) throw error;
          if (data && data.ok === false) {
            alert('Verify failed: ' + (data.error || 'unknown') + (data.hint ? '\n\n' + data.hint : ''));
            verifyBtn.disabled = false; verifyBtn.textContent = '✓ Complete callback & verify';
            return;
          }
          window.OF.tabs.closing(loan, me, supa, container); // re-render
        } catch (err) {
          alert('Verify failed: ' + err.message + '\n\nIf verify_wire is missing, run migration 029.');
          verifyBtn.disabled = false; verifyBtn.textContent = '✓ Complete callback & verify';
        }
      });
    }

    const fundBtn = container.querySelector('#of-fund-btn');
    if (fundBtn && !fundBtn.disabled) {
      fundBtn.addEventListener('click', async () => {
        if (!confirm(`Record funding for ${loan.loan_number || 'this loan'}${fundAmount ? ' (' + cents(fundAmount) + ' net)' : ''}?\n\nThis flips the loan to FUNDED. record_funding re-checks role + OFAC + verified wire server-side.`)) return;
        fundBtn.disabled = true; fundBtn.textContent = 'Funding…';
        try {
          const { data, error } = await supa.rpc('record_funding', { p_loan_id: loan.id, p_amount_cents: fundAmount });
          if (error) throw error;
          if (data && data.ok === false) {
            alert('Funding blocked: ' + (data.error || 'unknown') + (data.hint ? '\n\n' + data.hint : '') +
              (data.error === 'role_denied' ? '\n\n(Only admin/closer can fund. From the SQL editor auth.uid() is null — fund from the app while signed in.)' : ''));
            fundBtn.disabled = false; fundBtn.textContent = '▸ Record Funding';
            return;
          }
          window.OF.tabs.closing(loan, me, supa, container); // re-render → FUNDED
        } catch (err) {
          alert('Funding failed: ' + err.message + '\n\nIf record_funding is missing, run migrations 029 + 031.');
          fundBtn.disabled = false; fundBtn.textContent = '▸ Record Funding';
        }
      });
    }
  };

  // ─── small render helpers ──────────────────────────────────────────────
  function panel(titleTxt, pill, bodyHtml) {
    return `
      <div class="disc-panel">
        <div class="disc-panel-head"><span class="disc-panel-title">${esc(titleTxt)} ${pill || ''}</span></div>
        <div class="disc-panel-body">${bodyHtml}</div>
      </div>`;
  }
  function kv(rows) {
    return `<div class="disc-kv-grid">${rows.map(([k, v]) =>
      `<span class="disc-kv-key">${esc(k)}</span><span class="disc-kv-val">${v}</span>`).join('')}</div>`;
  }
  function empty(msg, ref) {
    return `<div class="disc-empty-body"><strong>${esc(msg)}</strong><span class="ref">Checklist ${esc(ref)}</span></div>`;
  }
  function reqSummary(reqs) {
    if (!Array.isArray(reqs) || reqs.length === 0) return '—';
    const cleared = reqs.filter(r => r && r.cleared).length;
    const cls = cleared === reqs.length ? 'green' : 'amber';
    return `<span class="${cls}">${cleared} / ${reqs.length} cleared</span>`;
  }
  function renderWire(w) {
    if (!w) {
      return `<div class="disc-empty-body"><strong>No wire instructions entered.</strong> Add a wire referencing a verified settlement agent, then callback-verify it before funding.<span class="ref">Checklist 13.0.2</span></div>`;
    }
    const verified = w.status === 'verified';
    let body = kv([
      ['Beneficiary', esc(w.beneficiary_name || '—')],
      ['Bank', esc(`${w.bank_name || '—'}${w.routing_last4 ? ' ····' + w.routing_last4 : ''}`)],
      ['Account', esc(w.account_last4 ? '····' + w.account_last4 : '—')],
      ['Amount', esc(cents(w.amount_cents))],
      ['Status', verified
        ? `<span class="green">verified</span><span class="sub">callback ${esc(ago(w.callback_completed_at))} · source ${esc(w.callback_phone_source || '—')}</span>`
        : '<span class="amber">pending verification</span>'],
    ]);
    if (!verified) {
      body += `
        <div style="margin-top:0.85rem;display:flex;gap:0.6rem;align-items:flex-end;flex-wrap:wrap;">
          <label style="font-family:var(--mono);font-size:0.58rem;letter-spacing:0.06em;color:var(--muted);text-transform:uppercase;">
            Callback phone source<br>
            <select id="of-cb-source" style="margin-top:0.3rem;background:var(--panel);border:1px solid var(--border);color:var(--white);padding:0.5rem 0.6rem;font-family:var(--sans);font-size:0.82rem;">
              <option value="independent">independent (directory / prior file)</option>
              <option value="from_email">from the wire email ⚠</option>
            </select>
          </label>
          <button id="of-verify-wire-btn" class="btn sm">✓ Complete callback &amp; verify</button>
        </div>`;
    }
    return body;
  }
})();
