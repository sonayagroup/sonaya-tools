/* CAM reconciliation engine — shared by the web app, the report and tests.
 * Two allocation methods are computed for every lease:
 *  - "current": how the Patel Paisano workbook has allocated CAM (office-only costs split by
 *    office square footage, building costs by total square footage; admin fee = pct × eligible
 *    CAM × tenant sq ft / total sq ft; management fee per the lease's mgmt_fee_mode).
 *  - "lease":   the lease wording (every pooled cost split by tenant sq ft / total leasable sq ft;
 *    admin fee = pct × the tenant's share of admin-eligible CAM; management fee = pct × gross
 *    rents of the development × tenant share).
 * Direct charges (basis 'space') go 100% to the lease on that space in both methods; 'owner'
 * categories are never billed.
 */
(function (root) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);

  function occupancy(lease, year) {
    const ys = Date.UTC(year, 0, 1), ye = Date.UTC(year + 1, 0, 1);
    const s = lease.lease_start ? Math.max(ys, Date.parse(lease.lease_start + 'T00:00:00Z')) : ys;
    const e = lease.lease_end ? Math.min(ye, Date.parse(lease.lease_end + 'T00:00:00Z') + 864e5) : ye;
    return Math.max(0, Math.min(1, (e - s) / (ye - ys)));
  }

  function compute(input) {
    const { property, spaces, categories, budgets = [], leases = [], leaseYears = [], invoices = [], year } = input;
    const warnings = [];
    const total = Number(property.total_sqft) || sum(spaces.map((s) => s.sqft));
    if (!property.total_sqft) warnings.push('Total leasable square footage is not set; using the sum of spaces.');
    const spaceById = Object.fromEntries(spaces.map((s) => [s.id, s]));
    const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
    const typeSqft = {};
    spaces.forEach((s) => { typeSqft[s.space_type] = (typeSqft[s.space_type] || 0) + Number(s.sqft); });

    // ---- actuals
    const inv = invoices.filter((i) => i.cam_year === year && i.status !== 'excluded');
    const confirmed = inv.filter((i) => i.status === 'confirmed');
    const pending = inv.filter((i) => i.status === 'needs_review');
    const byCat = {};
    categories.forEach((c) => (byCat[c.id] = { category: c, actual: 0, count: 0, pending: 0 }));
    confirmed.forEach((i) => { const b = byCat[i.category_id]; if (b) { b.actual += Number(i.amount) || 0; b.count++; } });
    pending.forEach((i) => { const b = byCat[i.category_id]; if (b) b.pending += Number(i.amount) || 0; });
    const uncategorized = confirmed.filter((i) => !catById[i.category_id]);
    if (uncategorized.length) warnings.push(uncategorized.length + ' confirmed invoice(s) have no category and are not counted.');

    // ---- building summary by report group
    const groups = [];
    const gIndex = {};
    categories.slice().sort((a, b) => a.sort - b.sort).forEach((c) => {
      if (!gIndex[c.report_group]) { gIndex[c.report_group] = { group: c.report_group, billable: c.basis !== 'owner', actual: 0, pending: 0, budget: null, sort: c.sort }; groups.push(gIndex[c.report_group]); }
      gIndex[c.report_group].actual += byCat[c.id].actual;
      gIndex[c.report_group].pending += byCat[c.id].pending;
    });
    budgets.filter((b) => b.year === year).forEach((b) => { if (gIndex[b.report_group]) gIndex[b.report_group].budget = Number(b.amount); });
    groups.forEach((g) => { g.actual = r2(g.actual); g.pending = r2(g.pending); g.difference = g.budget == null ? null : r2(g.budget - g.actual); });
    const billable = groups.filter((g) => g.billable);
    const buildingTotals = {
      budget: billable.some((g) => g.budget != null) ? r2(sum(billable.map((g) => g.budget))) : null,
      actual: r2(sum(billable.map((g) => g.actual))),
      pending: r2(sum(billable.map((g) => g.pending))),
    };
    buildingTotals.difference = buildingTotals.budget == null ? null : r2(buildingTotals.budget - buildingTotals.actual);

    const eligibleActual = sum(categories.filter((c) => c.admin_fee_eligible).map((c) => byCat[c.id].actual));
    const lyFor = (leaseId) => leaseYears.find((y) => y.lease_id === leaseId && y.year === year) || null;
    const activeLeases = leases.filter((l) => occupancy(l, year) > 0);
    const grossRents = sum(activeLeases.map((l) => (lyFor(l.id) || {}).rent_total));
    const rentsMissing = activeLeases.filter((l) => (lyFor(l.id) || {}).rent_total == null);

    function shareFor(lease, cat, method) {
      const sp = spaceById[lease.space_id]; if (!sp) return 0;
      if (cat.basis === 'owner') return 0;
      if (cat.basis === 'space') return cat.basis_value === sp.id ? 1 : 0;
      if (method === 'lease') return Number(sp.sqft) / total;
      if (cat.basis === 'building') return Number(sp.sqft) / total;
      if (cat.basis === 'space_type') return sp.space_type === cat.basis_value && typeSqft[cat.basis_value] ? Number(sp.sqft) / typeSqft[cat.basis_value] : 0;
      return 0;
    }

    function leaseCalc(lease, method) {
      const sp = spaceById[lease.space_id] || { sqft: 0 };
      const occ = occupancy(lease, year);
      const ly = lyFor(lease.id) || {};
      const lines = {};
      categories.forEach((c) => {
        const share = shareFor(lease, c, method) * occ;
        if (!share) return;
        const amt = byCat[c.id].actual * share;
        const L = (lines[c.report_group] = lines[c.report_group] || { group: c.report_group, amount: 0, detail: [] });
        L.amount += amt; L.detail.push({ category: c.name, total: r2(byCat[c.id].actual), share, amount: r2(amt) });
      });
      const shareTotal = sum(Object.values(lines).map((l) => l.amount));
      let admin = 0, adminBasis = '';
      if (!lease.related_party && Number(lease.admin_fee_pct) > 0) {
        if (method === 'lease') {
          const eligShare = sum(categories.filter((c) => c.admin_fee_eligible).map((c) => byCat[c.id].actual * shareFor(lease, c, 'lease') * occ));
          admin = eligShare * lease.admin_fee_pct / 100;
          adminBasis = `${lease.admin_fee_pct}% of tenant's share of CAM charges (${fmt(eligShare)})`;
        } else {
          admin = eligibleActual * lease.admin_fee_pct / 100 * (Number(sp.sqft) / total) * occ;
          adminBasis = `${lease.admin_fee_pct}% of CAM charges (${fmt(eligibleActual)}) × ${Number(sp.sqft).toLocaleString()} / ${total.toLocaleString()} sq ft`;
        }
      }
      let mgmt = 0, mgmtBasis = '';
      if (!lease.related_party && Number(lease.mgmt_fee_pct) > 0) {
        const mode = method === 'lease' ? 'shared_gross' : lease.mgmt_fee_mode;
        if (mode === 'own_rent') {
          if (ly.rent_total == null) warnings.push(`${lease.tenant_name}: ${year} rent is not entered; management fee is $0.`);
          mgmt = (Number(ly.rent_total) || 0) * lease.mgmt_fee_pct / 100;
          mgmtBasis = `${lease.mgmt_fee_pct}% of tenant's ${year} rent (${fmt(ly.rent_total || 0)})`;
        } else if (mode === 'shared_gross') {
          const sh = Number(sp.sqft) / total * occ;
          mgmt = grossRents * lease.mgmt_fee_pct / 100 * sh;
          mgmtBasis = `${lease.mgmt_fee_pct}% of gross rents (${fmt(grossRents)}) × ${(sh * 100).toFixed(1)}% share`;
        }
      }
      const actual = shareTotal + admin + mgmt;
      const budget = Number(ly.cam_budget) || 0;
      return {
        method, occupancy: occ, lines: Object.values(lines).map((l) => ({ ...l, amount: r2(l.amount) })),
        shareTotal: r2(shareTotal), admin: r2(admin), adminBasis, mgmt: r2(mgmt), mgmtBasis,
        actual: r2(actual), budget: r2(budget), due: r2(actual - budget), budgetMissing: !lyFor(lease.id),
      };
    }

    const leaseResults = activeLeases.map((l) => ({ leaseRow: l, space: spaceById[l.space_id], current: leaseCalc(l, 'current'), lease: leaseCalc(l, 'lease') }));
    // group by tenant
    const tenants = {};
    leaseResults.forEach((r) => {
      const t = (tenants[r.leaseRow.tenant_name] = tenants[r.leaseRow.tenant_name] || { tenant: r.leaseRow.tenant_name, leases: [], current: { actual: 0, budget: 0, due: 0 }, lease: { actual: 0, budget: 0, due: 0 }, sqft: 0, relatedParty: true });
      t.leases.push(r); t.sqft += Number((r.space || {}).sqft) || 0; t.relatedParty = t.relatedParty && !!r.leaseRow.related_party;
      ['current', 'lease'].forEach((m) => { const x = r[m === 'current' ? 'current' : 'lease']; t[m].actual += x.actual; t[m].budget += x.budget; t[m].due += x.due; });
    });
    Object.values(tenants).forEach((t) => ['current', 'lease'].forEach((m) => { t[m] = { actual: r2(t[m].actual), budget: r2(t[m].budget), due: r2(t[m].due) }; }));
    if (rentsMissing.length && activeLeases.some((l) => Number(l.mgmt_fee_pct) > 0))
      warnings.push('Lease-wording management fee uses gross rents of the whole property; rent is missing for: ' + rentsMissing.map((l) => l.tenant_name + ' (' + ((spaceById[l.space_id] || {}).name || '') + ')').join(', ') + '.');
    const vacant = spaces.filter((s) => !activeLeases.some((l) => l.space_id === s.id));

    return { year, totalSqft: total, groups, buildingTotals, byCategory: Object.values(byCat).map((b) => ({ ...b, actual: r2(b.actual), pending: r2(b.pending) })),
      leases: leaseResults, tenants: Object.values(tenants), vacant, pendingCount: pending.length, confirmedCount: confirmed.length, warnings: [...new Set(warnings)] };
  }

  function fmt(n) { const v = Number(n) || 0; return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /* Auto-categorize from vendor rules. text = vendor + file name + extracted text. */
  function suggestCategory(rules, text, amount) {
    const t = (text || '').toLowerCase();
    const hits = rules.filter((r) => t.includes(r.match.toLowerCase()) &&
      (r.amount_min == null || amount == null || amount >= r.amount_min) && (r.amount_max == null || amount == null || amount < r.amount_max));
    hits.sort((a, b) => b.priority - a.priority || b.match.length - a.match.length);
    return hits[0] || null;
  }

  /* Best-effort field extraction from invoice text (PDF text layer). */
  function extractFields(text) {
    const t = (text || '').replace(/\s+/g, ' ');
    const money = [...t.matchAll(/(?:amount due|total due|balance due|total amount|amount|total|payment)[^$0-9]{0,25}\$?\s?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/gi)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    const anyMoney = [...t.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    const amount = money.length ? money[money.length - 1] : anyMoney.length ? Math.max(...anyMoney) : null;
    let date = null;
    const m1 = t.match(/(?:invoice date|bill date|statement date|date)[^0-9]{0,12}(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i) || t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (m1) { let y = +m1[3]; if (y < 100) y += 2000; date = `${y}-${String(m1[1]).padStart(2, '0')}-${String(m1[2]).padStart(2, '0')}`; }
    if (!date) { const m2 = t.match(/\b(20\d\d)(\d\d)(\d\d)\b/); if (m2) date = `${m2[1]}-${m2[2]}-${m2[3]}`; }
    return { amount, date };
  }

  const api = { compute, occupancy, fmt, r2, suggestCategory, extractFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CamEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
