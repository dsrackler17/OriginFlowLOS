// ═══════════════════════════════════════════════════════════════════════════
// js/tabs/closing.js — CLOSING TAB module for loan.html
//
// Self-contained tab module. Registers itself as window.OF.tabs.closing and
// is invoked by loan.html's dispatcher with the contract:
//
//   window.OF.tabs.closing = async function(loan, me, supa, container) { … }
//
// Globals available (from /js/of-helpers.js, loaded before this file):
//   escapeHtml, dollars (cents→$), timeAgo, formatDate, titleCase, daysUntil
//
// Data layer — migration 029_closing_core.sql + 13.0.x:
//   settlement_statements / settlement_statement_lines
//   wire_instructions      (anti-fraud two-person callback; verify_wire() RPC)
//   closing_appointments
//   settlement_agents
//   closing_protection_letters
//   title_commitments      (Schedule A / B)
//   funding_events         (record_funding(p_loan_id, p_amount_cents) RPC)
//
// MONEY IS CENTS-NATIVE. Every *_cents column is passed through dollars().
//
// FAIL-OPEN CONTRACT: every section fetches independently inside try/catch.
// A missing table or column contributes an empty state for THAT section only —
// it never throws the whole tab. Raw Postgres errors are logged to console,
// never shown to the user (same hardening as the other reconciled tabs).
//
// ⚠ FLAGGED SCHEMA ASSUMPTIONS (per ship-with-flags): the exact column names
// below are inferred from 029_closing_core.sql naming conventions. Each
// assumed column is marked [ASSUME]. If a select 400s, the section fails open
// (empty state) and the console logs the real error — fix the select against
// the actual column and redeploy. No assumption can break the tab.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  window.OF = window.OF || {};
  window.OF.tabs = window.OF.tabs || {};

  // Module-scoped state for this tab render.
  const S = {
    loan: null, me: null, supa: null,
    statement: null, lines: [],
    wire: null, appt: null, agent: null,
    cpl: null, title: null, funding: [],
    profiles: {},
  };

  // ── ENTRY POINT ──────────────────────────────────────────────────────────
  window.OF.tabs.closing = async function (loan, me, supa, container) {
    S.loan = loan; S.me = me; S.supa = supa;
    if (!container) return;

    container.innerHTML = `
      <div class="disc-pane" id="closing-pane">
        <div class="disc-loading">
          <div class="disc-loading-spinner"></div>
          Loading closing workspace…
        </div>
      </div>
    `;

    // Fetch every section in parallel; each fails open to null/[].
    const [statement, wire, appt, agent, cpl, title, funding] = await Promise.all([
      fetchSettlement(),
      fetchWire(),
      fetchAppointment(),
      fetchAgent(),
      fetchCPL(),
      fetchTitle(),
      fetchFunding(),
    ]);
    S.statement = statement.row;
    S.lines     = statement.lines;
    S.wire      = wire;
    S.appt      = appt;
    S.agent     = agent;
    S.cpl       = cpl;
    S.title     = title;
    S.funding   = funding;

    // Resolve any actor profiles referenced across sections.
    const ids = [...new Set([
      wire?.verified_by_first, wire?.verified_by_second,
      appt?.created_by, ...(funding || []).map(f => f.recorded_by),
    ].filter(Boolean))];
    if (ids.length) {
      try {
        const { data } = await supa.from('profiles').select('id, full_name').in('id', ids);
        S.profiles = Object.fromEntries((data || []).map(p => [p.id, p]));
      } catch (_) { /* optional */ }
    }

    render(container);
  };

  // ── FETCHERS (each fails open) ─────────────────────────────────────────────
  async function fetchSettlement() {
    // [ASSUME] settlement_statements(loan_id, status, total_cents, prepared_at,
    //          version) + settlement_statement_lines(statement_id, section,
    //          description, amount_cents, paid_by, payee, line_order).
    try {
      const { data: rows, error } = await S.supa
        .from('settlement_statements')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (rows && rows[0]) || null;
      let lines = [];
      if (row) {
        try {
          const { data: ld } = await S.supa
            .from('settlement_statement_lines')
            .select('*')
            .eq('statement_id', row.id);
          lines = ld || [];
        } catch (e) { console.error('[Closing] statement lines:', e); }
      }
      return { row, lines };
    } catch (e) {
      console.error('[Closing] settlement_statements:', e);
      return { row: null, lines: [] };
    }
  }

  async function fetchWire() {
    // [ASSUME] wire_instructions(loan_id, beneficiary_name, bank_name,
    //          account_last4, routing_last4, amount_cents, status,
    //          verified_at, verified_by_first, verified_by_second,
    //          callback_completed_at, callback_phone_last4).
    try {
      const { data, error } = await S.supa
        .from('wire_instructions')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) { console.error('[Closing] wire_instructions:', e); return null; }
  }

  async function fetchAppointment() {
    // [ASSUME] closing_appointments(loan_id, scheduled_at, location, type,
    //          status, created_by).
    try {
      const { data, error } = await S.supa
        .from('closing_appointments')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) { console.error('[Closing] closing_appointments:', e); return null; }
  }

  async function fetchAgent() {
    // [ASSUME] settlement_agents(id, name, company, email, phone, license_no);
    //          closing_appointments or settlement_statements may carry
    //          settlement_agent_id. We look it up via the statement first.
    try {
      const agentId = S.statement?.settlement_agent_id
        || S.statement?.agent_id
        || null;
      if (!agentId) {
        // Fall back to any agent linked directly to the loan, if such a link exists.
        const { data, error } = await S.supa
          .from('settlement_agents')
          .select('*')
          .eq('loan_id', S.loan.id)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        return data || null;
      }
      const { data, error } = await S.supa
        .from('settlement_agents')
        .select('*')
        .eq('id', agentId)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) { console.error('[Closing] settlement_agents:', e); return null; }
  }

  async function fetchCPL() {
    // [ASSUME] closing_protection_letters(loan_id, status, issued_at,
    //          expires_at, amount_cents, underwriter, file_no).
    try {
      const { data, error } = await S.supa
        .from('closing_protection_letters')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('issued_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) { console.error('[Closing] closing_protection_letters:', e); return null; }
  }

  async function fetchTitle() {
    // [ASSUME] title_commitments(loan_id, status, effective_date,
    //          schedule_a, schedule_b, commitment_no, title_company).
    try {
      const { data, error } = await S.supa
        .from('title_commitments')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    } catch (e) { console.error('[Closing] title_commitments:', e); return null; }
  }

  async function fetchFunding() {
    // [ASSUME] funding_events(loan_id, amount_cents, recorded_at, recorded_by,
    //          status).
    try {
      const { data, error } = await S.supa
        .from('funding_events')
        .select('*')
        .eq('loan_id', S.loan.id)
        .order('recorded_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (e) { console.error('[Closing] funding_events:', e); return []; }
  }

  // ── RENDER ─────────────────────────────────────────────────────────────────
  function render(container) {
    const paneEl = container.querySelector('#closing-pane') || container;
    const isFunded = String(S.loan.status || '').toLowerCase().includes('fund')
      || (S.funding && S.funding.length > 0);

    let html = '';

    html += renderFundingBanner(isFunded);
    html += `<div class="dec-review-grid">`;
    html += renderTitlePanel();
    html += renderCPLPanel();
    html += renderWirePanel();
    html += renderApptPanel();
    html += `</div>`;
    html += renderSettlementPanel();
    html += renderAgentPanel();
    html += renderFundingPanel(isFunded);

    paneEl.innerHTML = html;

    // Wire the fund button (closer-only action; RPC enforces the real gate).
    const fundBtn = paneEl.querySelector('#closing-fund-btn');
    if (fundBtn) fundBtn.addEventListener('click', onFundClick);
  }

  function renderFundingBanner(isFunded) {
    if (isFunded) {
      const f = (S.funding && S.funding[0]) || null;
      return `
        <div class="dec-current-banner approve">
          <span class="dec-current-icon">✓</span>
          <div>
            <div class="dec-current-label">Funding Status</div>
            <div class="dec-current-decision">Funded</div>
            <div class="dec-current-meta">
              ${f ? `${escapeHtml(dollars(f.amount_cents))} · ${escapeHtml(timeAgo(f.recorded_at))}` : 'Loan funded'}
            </div>
          </div>
          <span></span>
        </div>
      `;
    }
    return `
      <div class="dec-current-banner suspend">
        <span class="dec-current-icon">⏱</span>
        <div>
          <div class="dec-current-label">Funding Status</div>
          <div class="dec-current-decision">Not Yet Funded</div>
          <div class="dec-current-meta">
            Funding is gated by CIP/BSA (032) and OFAC (030/031). Complete the
            checklist below before recording funding.
          </div>
        </div>
        <span></span>
      </div>
    `;
  }

  function panel(title, pillHtml, bodyHtml, actionsHtml) {
    return `
      <div class="disc-panel">
        <div class="disc-panel-head">
          <span class="disc-panel-title">${escapeHtml(title)} ${pillHtml || ''}</span>
          <div class="disc-panel-actions">${actionsHtml || ''}</div>
        </div>
        <div class="disc-panel-body">${bodyHtml}</div>
      </div>
    `;
  }

  function emptyBody(msg, ref) {
    return `
      <div class="disc-empty-body">
        <strong>${escapeHtml(msg)}</strong>
        ${ref ? `<span class="ref">${escapeHtml(ref)}</span>` : ''}
      </div>
    `;
  }

  function kv(rows) {
    return `<div class="disc-kv-grid">${rows.map(([k, v]) =>
      `<span class="disc-kv-key">${escapeHtml(k)}</span><span class="disc-kv-val">${v == null ? '<span class="sub">—</span>' : v}</span>`
    ).join('')}</div>`;
  }

  function renderTitlePanel() {
    const t = S.title;
    if (!t) return panel('Title Commitment',
      '<span class="disc-status-pill na">None</span>',
      emptyBody('No title commitment on file.', 'Gated by 13.0.10'));
    const pill = t.status === 'cleared' || t.status === 'final'
      ? '<span class="disc-status-pill delivered">Cleared</span>'
      : '<span class="disc-status-pill pending">In Review</span>';
    return panel('Title Commitment', pill, kv([
      ['Commitment #', t.commitment_no ? escapeHtml(t.commitment_no) : null],
      ['Title Company', t.title_company ? escapeHtml(t.title_company) : null],
      ['Effective', t.effective_date ? escapeHtml(formatDate(t.effective_date)) : null],
      ['Status', t.status ? escapeHtml(titleCase(String(t.status))) : null],
    ]));
  }

  function renderCPLPanel() {
    const c = S.cpl;
    if (!c) return panel('Closing Protection Letter',
      '<span class="disc-status-pill na">None</span>',
      emptyBody('No CPL issued.', 'Gated by 13.0.9'));
    const expired = c.expires_at && daysUntil(c.expires_at) < 0;
    const pill = expired
      ? '<span class="disc-status-pill missing">Expired</span>'
      : '<span class="disc-status-pill delivered">Active</span>';
    return panel('Closing Protection Letter', pill, kv([
      ['File #', c.file_no ? escapeHtml(c.file_no) : null],
      ['Underwriter', c.underwriter ? escapeHtml(c.underwriter) : null],
      ['Coverage', c.amount_cents != null ? escapeHtml(dollars(c.amount_cents)) : null],
      ['Issued', c.issued_at ? escapeHtml(formatDate(c.issued_at)) : null],
      ['Expires', c.expires_at ? `<span class="${expired ? 'red' : ''}">${escapeHtml(formatDate(c.expires_at))}</span>` : null],
    ]));
  }

  function renderWirePanel() {
    const w = S.wire;
    if (!w) return panel('Wire Instructions',
      '<span class="disc-status-pill na">None</span>',
      emptyBody('No wire instructions entered.', 'Gated by 13.0.2'));
    const verified = !!w.verified_at;
    const pill = verified
      ? '<span class="disc-status-pill delivered">Verified</span>'
      : '<span class="disc-status-pill pending">Unverified</span>';
    const v1 = S.profiles[w.verified_by_first]?.full_name;
    const v2 = S.profiles[w.verified_by_second]?.full_name;
    const body = kv([
      ['Beneficiary', w.beneficiary_name ? escapeHtml(w.beneficiary_name) : null],
      ['Bank', w.bank_name ? escapeHtml(w.bank_name) : null],
      ['Account', w.account_last4 ? '••••' + escapeHtml(String(w.account_last4)) : null],
      ['Routing', w.routing_last4 ? '••••' + escapeHtml(String(w.routing_last4)) : null],
      ['Amount', w.amount_cents != null ? escapeHtml(dollars(w.amount_cents)) : null],
      ['Two-person callback', verified
        ? `<span class="green">Completed${w.callback_completed_at ? ' · ' + escapeHtml(formatDate(w.callback_completed_at)) : ''}</span>${(v1 || v2) ? `<span class="sub">${escapeHtml([v1, v2].filter(Boolean).join(' + '))}</span>` : ''}`
        : '<span class="amber">Pending — anti-fraud callback required before wire release</span>'],
    ]);
    const actions = verified ? '' :
      `<button class="btn sm" onclick="alert('Wire verification uses the verify_wire() RPC with the two-person callback control (13.0.2). The two verifiers must be different staff users; the RPC stamps verified_by_first/second + callback_completed_at.')">Verify Wire</button>`;
    return panel('Wire Instructions', pill, body, actions);
  }

  function renderApptPanel() {
    const a = S.appt;
    if (!a) return panel('Closing Appointment',
      '<span class="disc-status-pill na">Unscheduled</span>',
      emptyBody('No closing appointment scheduled.', 'Gated by 13.0.3'));
    const when = a.scheduled_at;
    const upcoming = when && daysUntil(when) >= 0;
    const pill = upcoming
      ? '<span class="disc-status-pill delivered">Scheduled</span>'
      : '<span class="disc-status-pill na">Past</span>';
    return panel('Closing Appointment', pill, kv([
      ['When', when ? `${escapeHtml(formatDate(when))}${upcoming ? `<span class="sub">in ${daysUntil(when)}d</span>` : ''}` : null],
      ['Type', a.type ? escapeHtml(titleCase(String(a.type).replace(/_/g, ' '))) : null],
      ['Location', a.location ? escapeHtml(a.location) : null],
      ['Status', a.status ? escapeHtml(titleCase(String(a.status))) : null],
    ]));
  }

  function renderAgentPanel() {
    const g = S.agent;
    if (!g) return panel('Settlement Agent',
      '<span class="disc-status-pill na">Unassigned</span>',
      emptyBody('No settlement agent assigned.', 'Gated by 13.0.8'));
    return panel('Settlement Agent', '', kv([
      ['Name', g.name ? escapeHtml(g.name) : null],
      ['Company', g.company ? escapeHtml(g.company) : null],
      ['Contact', [g.email, g.phone].filter(Boolean).map(escapeHtml).join(' · ') || null],
      ['License #', g.license_no ? escapeHtml(g.license_no) : null],
    ]));
  }

  function renderSettlementPanel() {
    const s = S.statement;
    if (!s) return panel('Settlement Statement',
      '<span class="disc-status-pill na">None</span>',
      emptyBody('No settlement statement prepared.', 'Gated by 13.0.1'));
    const pill = `<span class="disc-status-pill ${s.status === 'final' ? 'delivered' : 'pending'}">${escapeHtml(titleCase(String(s.status || 'draft')))}</span>`;
    let body = kv([
      ['Version', s.version != null ? 'v' + escapeHtml(String(s.version)) : null],
      ['Total', s.total_cents != null ? `<strong>${escapeHtml(dollars(s.total_cents))}</strong>` : null],
      ['Prepared', s.prepared_at ? escapeHtml(formatDate(s.prepared_at)) : null],
    ]);
    if (S.lines.length) {
      const ordered = S.lines.slice().sort((a, b) => (a.line_order || 0) - (b.line_order || 0));
      body += `
        <div class="disc-history">
          <div class="disc-history-head">Statement Lines (${S.lines.length})</div>
          ${ordered.map(l => `
            <div class="disc-history-row">
              <span class="disc-history-version">${escapeHtml(String(l.section || '—')).slice(0, 6)}</span>
              <div class="disc-history-info">
                ${escapeHtml(l.description || 'Line item')}
                ${l.payee ? `<span class="reason">to ${escapeHtml(l.payee)}${l.paid_by ? ' · paid by ' + escapeHtml(l.paid_by) : ''}</span>` : ''}
              </div>
              <span class="disc-history-when">${l.amount_cents != null ? escapeHtml(dollars(l.amount_cents)) : '—'}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
    return panel('Settlement Statement', pill, body);
  }

  function renderFundingPanel(isFunded) {
    let body;
    if (isFunded && S.funding.length) {
      body = S.funding.map(f => `
        <div class="dec-history-row">
          <span class="dec-history-pill approve">FUNDED</span>
          <div class="dec-history-body">
            ${escapeHtml(dollars(f.amount_cents))}
            ${f.recorded_by && S.profiles[f.recorded_by] ? `<small>by ${escapeHtml(S.profiles[f.recorded_by].full_name)}</small>` : ''}
          </div>
          <span class="dec-history-when">${escapeHtml(timeAgo(f.recorded_at))}</span>
        </div>
      `).join('');
    } else {
      const isCloser = String(S.me?.role || '').toLowerCase() === 'closer'
        || String(S.me?.role || '').toLowerCase() === 'admin';
      body = `
        <div class="disc-empty-body" style="margin-bottom: 1rem;">
          <strong>This loan has not been funded.</strong><br>
          Recording funding runs record_funding(), which hard-gates on CIP/BSA
          (032) and OFAC (030/031). If those aren't satisfied, funding is refused.
        </div>
        <div style="display:flex; justify-content:flex-end;">
          <button class="dec-submit-btn approve" id="closing-fund-btn" ${isCloser ? '' : 'disabled title="Closer or admin role required"'}>
            ${isCloser ? 'Record Funding' : 'Record Funding (closer only)'}
          </button>
        </div>
      `;
    }
    return panel('Funding', '', body);
  }

  // ── FUND ACTION ────────────────────────────────────────────────────────────
  // Calls record_funding(p_loan_id, p_amount_cents). The RPC returns a JSON
  // envelope: { ok: true, ... } on success, or { ok: false, error, hint } when
  // a gate refuses (e.g. cip_not_verified). We surface the hint to the user as
  // a clean message — never a raw error.
  async function onFundClick(e) {
    const btn = e.currentTarget;
    // Default the amount to the loan amount (cents-native). Confirm before firing.
    const amountCents = S.loan.loan_amount_cents != null ? S.loan.loan_amount_cents : null;
    if (amountCents == null) {
      alert('No loan amount on file — cannot record funding.');
      return;
    }
    if (!confirm(`Record funding of ${dollars(amountCents)} for ${S.loan.loan_number || 'this loan'}?\n\nThis runs the CIP/OFAC funding gate. If any gate fails, funding is refused.`)) {
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Recording…';
    try {
      const { data, error } = await S.supa.rpc('record_funding', {
        p_loan_id: S.loan.id,
        p_amount_cents: amountCents,
      });
      if (error) throw error;
      // record_funding returns its own envelope.
      if (data && data.ok === false) {
        const msg = data.hint || prettyFundError(data.error) || 'Funding was refused by a compliance gate.';
        alert('Funding not recorded:\n\n' + msg);
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      // Success — reload the tab.
      await window.OF.tabs.closing(S.loan, S.me, S.supa, document.getElementById('tab-content'));
    } catch (err) {
      console.error('[Closing] record_funding:', err);
      alert('Could not record funding right now. This has been logged — try again in a moment.');
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function prettyFundError(code) {
    const map = {
      cip_not_verified:  'Complete CIP verification (4 elements) before funding.',
      ofac_hit:          'OFAC/SDN screening is not clear. Resolve before funding.',
      ofac_not_cleared:  'OFAC/SDN screening has not been completed.',
      role_denied:       'Your role is not permitted to record funding (closer required).',
      wire_not_verified: 'Wire instructions must pass the two-person callback first.',
      already_funded:    'This loan is already funded.',
    };
    return map[code] || null;
  }

})();
