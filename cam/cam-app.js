/* CAM Reconciliation web app (tools.sonayagroup.com/cam) */
const SUPABASE_URL = 'https://vcukhvjwsuaqxgqzotwb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjdWtodmp3c3VhcXhncXpvdHdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxODM0MzcsImV4cCI6MjEwMTc1OTQzN30.Ae-OUd1ZF9kxficp2U17flloRZ43xkcrbP_QqufhVXE';
const BUCKET = 'cam-invoices';
const E = window.CamEngine;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const S = { me: null, role: null, properties: [], propId: null, year: new Date().getFullYear(), tab: 'overview',
  spaces: [], categories: [], budgets: [], leases: [], leaseYears: [], rules: [], invoices: [], filters: { cat: '', status: '', q: '' }, report: { tenant: '', method: 'current' } };

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = E.fmt;
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
const canWrite = () => S.role === 'owner' || S.role === 'finance';
const fmtDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '—');
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = 'none'), ms); }
function openModal(html) { $('modalBox').innerHTML = html; $('modal').style.display = 'flex'; }
function closeModal() { $('modal').style.display = 'none'; }
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
async function must(p, okMsg) { const { data, error } = await p; if (error) { toast('Error: ' + error.message, 5000); throw error; } if (okMsg) toast(okMsg); return data; }
const prop = () => S.properties.find((p) => p.id === S.propId) || {};
const catName = (id) => (S.categories.find((c) => c.id === id) || {}).name || '— Uncategorized —';
const STATUS_LABEL = { confirmed: 'Counted', needs_review: 'To review', excluded: 'Not CAM' };
const STATUS_PILL = { confirmed: 'ok', needs_review: 'review', excluded: 'ex' };
const SOURCE_LABEL = { import: 'From workbook', upload: 'Uploaded', drive: 'Found in Drive', manual: 'Typed in' };
const statusPill = (s) => `<span class="pill ${STATUS_PILL[s] || ''}">${STATUS_LABEL[s] || esc(s)}</span>`;
const isLeaseOnlyWarning = (w) => /^Lease-wording/.test(w);
// Prevent the browser from opening a file that is dropped outside the drop zone.
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { if (!e.target.closest || !e.target.closest('#drop')) e.preventDefault(); }));
async function logAct(action, detail) { try { await sb.from('cam_activity').insert({ property_id: S.propId, actor: S.me.email, action, detail }); } catch (e) {} }

/* ---------- auth ---------- */
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('lgErr').textContent = '';
  const btn = e.submitter || e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email: $('lgEmail').value.trim(), password: $('lgPass').value });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { $('lgErr').textContent = error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message; return; }
  boot();
});
$('btnSignOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };

let booting = false;
async function boot() {
  if (booting) return; booting = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $('loading').classList.add('hidden'); $('gate').classList.remove('hidden'); return; }
    const { data: me } = await sb.from('cam_users').select('*').eq('user_id', session.user.id).maybeSingle();
    if (!me || !me.active) { $('loading').classList.add('hidden'); $('gate').classList.remove('hidden'); $('lgErr').textContent = 'Your account does not have access to the CAM tool yet. Ask Pranav to add you.'; booting = false; await sb.auth.signOut({ scope: 'local' }); return; }
    await start(me);
  } finally { booting = false; }
}
async function start(me) {
  S.me = me; S.role = me.role; $('gate').classList.add('hidden');
  $('whoami').textContent = (me.name || me.email) + ' · ' + ({ owner: 'Owner', finance: 'Finance (can edit)', viewer: 'View only' }[me.role] || me.role);
  S.properties = await must(sb.from('cam_properties').select('*').order('name'));
  const saved = (() => { try { return JSON.parse(localStorage.getItem('cam.ui') || '{}'); } catch (e) { return {}; } })();
  S.propId = (S.properties.find((p) => p.id === saved.propId) || S.properties.find((p) => p.status === 'active') || S.properties[0] || {}).id;
  if (saved.year) S.year = saved.year;
  fillSelectors(); await loadProperty(); wireDrop(); $('loading').classList.add('hidden'); go(saved.tab || 'overview');
}
function saveUi() { try { localStorage.setItem('cam.ui', JSON.stringify({ propId: S.propId, year: S.year, tab: S.tab })); } catch (e) {} }
function fillSelectors() {
  $('selProperty').innerHTML = S.properties.map((p) => `<option value="${p.id}" ${p.id === S.propId ? 'selected' : ''}>${esc(p.name)}${p.status === 'not_leased' ? ' (not leased)' : ''}</option>`).join('') + (S.role === 'owner' ? '<option value="__new">+ Add property…</option>' : '');
  const years = new Set([new Date().getFullYear(), new Date().getFullYear() - 1, S.year, ...S.invoices.map((i) => i.cam_year)]);
  $('selYear').innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option ${y === S.year ? 'selected' : ''}>${y}</option>`).join('');
}
$('selProperty').onchange = async (e) => { if (e.target.value === '__new') { e.target.value = S.propId; return newPropertyModal(); } S.propId = e.target.value; await loadProperty(); render(); saveUi(); };
$('selYear').onchange = (e) => { S.year = +e.target.value; render(); saveUi(); };
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
function go(tab) { S.tab = tab; document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab)); document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + tab)); render(); saveUi(); }

async function loadProperty() {
  const id = S.propId; if (!id) return;
  const [sp, ca, bu, le, ru, inv] = await Promise.all([
    sb.from('cam_spaces').select('*').eq('property_id', id).order('name'),
    sb.from('cam_categories').select('*').eq('property_id', id).order('sort'),
    sb.from('cam_budgets').select('*').eq('property_id', id),
    sb.from('cam_leases').select('*').eq('property_id', id).order('tenant_name'),
    sb.from('cam_vendor_rules').select('*').eq('property_id', id).order('priority', { ascending: false }),
    sb.from('cam_invoices').select('*').eq('property_id', id).order('invoice_date', { ascending: false }).limit(5000),
  ]);
  S.spaces = sp.data || []; S.categories = ca.data || []; S.budgets = bu.data || []; S.leases = le.data || []; S.rules = ru.data || []; S.invoices = inv.data || [];
  S.leaseYears = S.leases.length ? (await sb.from('cam_lease_years').select('*').in('lease_id', S.leases.map((l) => l.id))).data || [] : [];
  fillSelectors();
}
const calc = (year = S.year) => E.compute({ property: prop(), spaces: S.spaces, categories: S.categories, budgets: S.budgets, leases: S.leases, leaseYears: S.leaseYears, invoices: S.invoices, year });

function render() {
  const n = S.invoices.filter((i) => i.status === 'needs_review').length;
  $('reviewCount').textContent = n; $('reviewCount').classList.toggle('hidden', !n);
  ({ overview: renderOverview, add: renderAdd, review: renderReview, invoices: renderInvoices, report: renderReport, settings: renderSettings })[S.tab]();
}

/* ---------- overview ---------- */
function notesHtml(warnings) {
  if (!warnings.length) return '';
  return `<details class="notes"><summary>⚠ ${warnings.length} thing${warnings.length > 1 ? 's' : ''} to tidy up in Setup (click to see)</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
}
function renderOverview() {
  const el = $('tab-overview'); const p = prop();
  if (!S.spaces.length) { el.innerHTML = `<div class="card"><h2>${esc(p.name || 'No property yet')}</h2><p class="hint" style="margin:6px 0 12px">${p.status === 'not_leased' ? 'This property isn’t leased yet, so there’s nothing to reconcile.' : 'This property has no spaces set up yet.'} When it’s ready, go to <b>Setup</b> and add its spaces (suites and square footage), then the leases. Invoices can be tracked as soon as categories exist.</p>${canWrite() ? '<button class="btn primary" onclick="go(\'settings\')">Go to Setup</button>' : ''}</div>`; return; }
  const r = calc(); const now = new Date(); const isCur = S.year === now.getFullYear();
  const frac = isCur ? (now - new Date(S.year, 0, 1)) / (new Date(S.year + 1, 0, 1) - new Date(S.year, 0, 1)) : 1;
  const bt = r.buildingTotals;
  const pendAll = S.invoices.filter((i) => i.status === 'needs_review');
  const pend = pendAll.filter((i) => i.cam_year === S.year);
  const last = S.invoices.filter((i) => i.cam_year === S.year && i.status === 'confirmed').map((i) => i.invoice_date).filter(Boolean).sort().pop();
  const third = r.tenants.filter((t) => !t.relatedParty);
  let h = `<div class="steps noprint">
    <div class="step" onclick="go('add')"><div class="num">1</div><div><b>Add invoices</b><span>Drop files in, or let Claude pick them up from Google Drive.</span></div></div>
    <div class="step ${pendAll.length ? 'alert' : ''}" onclick="go('review')"><div class="num">2</div><div><b>Check them</b><span>${pendAll.length ? `${pendAll.length} invoice${pendAll.length > 1 ? 's are' : ' is'} waiting for you.` : 'Nothing waiting — all caught up.'}</span></div></div>
    <div class="step" onclick="go('report')"><div class="num">3</div><div><b>Send the year-end statement</b><span>Print or save a PDF for each tenant.</span></div></div></div>`;
  h += notesHtml(r.warnings.filter((w) => !isLeaseOnlyWarning(w)));
  h += `<div class="kpis">
    <div class="kpi"><div class="l">Spent on CAM ${isCur ? 'so far in ' : 'in '}${S.year}</div><div class="v">${fmt(bt.actual)}</div><div class="s">${r.confirmedCount} invoices counted${last ? ' · newest ' + fmtDate(last) : ''}</div></div>
    <div class="kpi"><div class="l">${S.year} budget</div><div class="v">${bt.budget == null ? '—' : fmt(bt.budget)}</div><div class="s">${bt.budget == null ? 'Not entered yet — add it in Setup' : (isCur ? `By now we'd expect about ${fmt(bt.budget * frac)}` : (bt.actual > bt.budget ? fmt(bt.actual - bt.budget) + ' over budget' : fmt(bt.budget - bt.actual) + ' under budget'))}</div></div>
    <div class="kpi wait"><div class="l">Waiting for review</div><div class="v">${pend.length}</div><div class="s">${pend.length ? fmt(pend.reduce((s, i) => s + (+i.amount || 0), 0)) + ' not counted yet' : 'Nothing waiting for ' + S.year}</div></div>
    ${third.map((t) => `<div class="kpi ${t.current.due > 0 ? 'owe' : 'credit'}"><div class="l">${esc(t.tenant)} ${t.current.due > 0 ? 'owes' : 'is owed'}</div><div class="v ${t.current.due > 0 ? 'owe' : 'credit'}">${fmt(Math.abs(t.current.due))}</div><div class="s">${isCur ? 'Estimate so far — ' : ''}their share ${fmt(t.current.actual)} vs. ${fmt(t.current.budget)} CAM billed</div></div>`).join('')}
  </div>`;
  h += `<div class="card"><h2>Where the money went — ${S.year}</h2><p class="hint">Building-wide spending by statement line, against the budget.${isCur ? ` ${(frac * 100).toFixed(0)}% of the year has passed.` : ''}</p><div class="scroll"><table class="tbl"><thead><tr><th>Category</th><th class="n">Budget</th><th class="n">Spent</th><th style="width:22%">Budget used</th><th class="n">Left in budget</th><th class="n">Waiting for review</th></tr></thead><tbody>`;
  r.groups.forEach((g) => { if (!g.billable && !g.actual && !g.pending) return; const pct = g.budget ? g.actual / g.budget : null;
    h += `<tr><td>${esc(g.group)}${g.billable ? '' : ' <span class="pill">owner pays</span>'}</td><td class="n">${g.budget == null ? '—' : fmt(g.budget)}</td><td class="n">${fmt(g.actual)}</td><td>${pct == null ? '<span class="muted small">no budget</span>' : `<div class="bar"><i class="${pct > 1 ? 'over' : ''}" style="width:${Math.min(100, pct * 100)}%"></i></div><span class="muted" style="font-size:11px">${(pct * 100).toFixed(0)}%</span>`}</td><td class="n ${g.difference != null && g.difference < 0 ? 'owe' : ''}">${g.difference == null ? '—' : (g.difference < 0 ? fmt(-g.difference) + ' over' : fmt(g.difference))}</td><td class="n muted">${g.pending ? fmt(g.pending) : ''}</td></tr>`; });
  h += `<tr class="total"><td>Total shared with tenants</td><td class="n">${bt.budget == null ? '—' : fmt(bt.budget)}</td><td class="n">${fmt(bt.actual)}</td><td></td><td class="n">${bt.difference == null ? '—' : (bt.difference < 0 ? fmt(-bt.difference) + ' over' : fmt(bt.difference))}</td><td class="n muted">${bt.pending ? fmt(bt.pending) : ''}</td></tr></tbody></table></div></div>`;
  // month grid
  const months = [...Array(12).keys()]; const bill = S.categories.filter((c) => c.basis !== 'owner');
  const grid = {}; S.invoices.filter((i) => i.cam_year === S.year && i.status === 'confirmed' && i.invoice_date).forEach((i) => { const cat = S.categories.find((c) => c.id === i.category_id); if (!cat || cat.basis === 'owner') return; const dy = +i.invoice_date.slice(0, 4); const m = dy < S.year ? 0 : dy > S.year ? 11 : +i.invoice_date.slice(5, 7) - 1; grid[cat.report_group] = grid[cat.report_group] || Array(12).fill(0); grid[cat.report_group][m] += +i.amount || 0; });
  const gs = [...new Set(bill.map((c) => c.report_group))];
  const lastMonth = isCur ? now.getMonth() : 11;
  h += `<div class="card"><h2>Month by month</h2><p class="hint">Dollars by invoice date (rounded). The bottom row is the running total for the year.</p><div class="scroll"><table class="tbl"><thead><tr><th>Category</th>${months.map((m) => `<th class="n">${new Date(2000, m, 1).toLocaleString('en-US', { month: 'short' })}</th>`).join('')}</tr></thead><tbody>`;
  const colTot = Array(12).fill(0); let run = 0;
  gs.forEach((g) => { const a = grid[g] || Array(12).fill(0); a.forEach((v, i) => (colTot[i] += v)); h += `<tr><td>${esc(g)}</td>${a.map((v) => `<td class="n">${v ? Math.round(v).toLocaleString() : '<span class="muted">–</span>'}</td>`).join('')}</tr>`; });
  h += `<tr class="total"><td>Month total</td>${colTot.map((v) => `<td class="n">${v ? Math.round(v).toLocaleString() : ''}</td>`).join('')}</tr><tr><td><b>Running total</b></td>${colTot.map((v, i) => { run += v; return `<td class="n"><b>${i <= lastMonth ? Math.round(run).toLocaleString() : ''}</b></td>`; }).join('')}</tr></tbody></table></div></div>`;
  // tenants
  h += `<div class="card"><h2>What each tenant owes${isCur ? ' (estimate so far)' : ''}</h2><p class="hint">Each tenant's share of the actual costs, minus the CAM they already paid during the year. <b class="owe">Red</b> = tenant owes us. <b class="credit">Green</b> = we owe the tenant a credit.</p><div class="scroll"><table class="tbl"><thead><tr><th>Tenant</th><th class="n">Sq ft</th><th class="n">CAM paid during year</th><th class="n">Their share of actual costs</th><th class="n">Owes / (credit)</th><th></th></tr></thead><tbody>`;
  r.tenants.forEach((t, ix) => { h += `<tr><td><b>${esc(t.tenant)}</b>${t.relatedParty ? ' <span class="pill blue">related company</span>' : ''}</td><td class="n">${t.sqft.toLocaleString()}</td><td class="n">${fmt(t.current.budget)}</td><td class="n">${fmt(t.current.actual)}</td><td class="n ${t.current.due > 0 ? 'owe' : 'credit'}"><b>${t.current.due < 0 ? '(' + fmt(-t.current.due) + ')' : fmt(t.current.due)}</b></td><td><button class="btn sm" data-tenant-ix="${ix}">Open statement</button></td></tr>`; });
  if (r.vacant.length) h += `<tr><td class="muted" colspan="6">Vacant: ${r.vacant.map((v) => esc(v.name) + ' (' + Number(v.sqft).toLocaleString() + ' sq ft)').join(', ')} — the owner absorbs this share.</td></tr>`;
  h += `</tbody></table></div>${isCur ? `<p class="muted small" style="margin:10px 0 0">For ${S.year}, the "CAM paid" column is the full year's billing, while costs only run through ${last ? fmtDate(last) : 'today'}. The number will move as the rest of the year's bills come in.</p>` : ''}</div>`;
  el.innerHTML = h;
  el.querySelectorAll('[data-tenant-ix]').forEach((b) => (b.onclick = () => { S.report.tenant = r.tenants[+b.dataset.tenantIx].tenant; go('report'); }));
}

/* ---------- add: upload & manual ---------- */
function catOptions(sel) { return `<option value="">— choose —</option>` + S.categories.filter((c) => c.active).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join(''); }
function wireDrop() {
  const drop = $('drop'), fi = $('fileInput');
  if (drop.dataset.wired) return; drop.dataset.wired = '1';
  drop.onclick = () => fi.click();
  fi.onchange = () => { handleFiles([...fi.files]); fi.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));
}
function renderAdd() {
  $('drop').classList.toggle('hidden', !canWrite());
  const today = new Date(); const ymd = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('manualForm').innerHTML = canWrite() ? `<div class="form">
    <label>Invoice date<input type="date" id="mDate" value="${ymd}"></label>
    <label>Vendor<input id="mVendor" list="vendorList" placeholder="e.g. PNM"></label>
    <label>Amount ($)<input id="mAmount" inputmode="decimal" placeholder="0.00"></label>
    <label>Category<select id="mCat">${catOptions()}</select></label>
    <label class="wide">Description (optional)<input id="mDesc" placeholder="e.g. Electric – October"></label>
    <div><button class="btn primary" id="mSave">Add invoice</button></div></div>
    <datalist id="vendorList">${[...new Set(S.invoices.map((i) => i.vendor).filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join('')}</datalist>` : '<p class="muted">You have view-only access.</p>';
  if (!canWrite()) return;
  const suggest = () => { const r = E.suggestCategory(S.rules, $('mVendor').value, num($('mAmount').value)); if (r) { $('mCat').value = r.category_id; if (!$('mDesc').value) $('mDesc').value = r.description || ''; } };
  $('mVendor').onchange = suggest; $('mAmount').onchange = () => { if (!$('mCat').value) suggest(); };
  $('mSave').onclick = async () => {
    const d = $('mDate').value, amt = num($('mAmount').value);
    if (!d || !$('mVendor').value.trim() || amt == null || isNaN(amt) || !$('mCat').value) return toast('Please fill in the date, vendor, amount and category.');
    $('mSave').disabled = true;
    try {
      await must(sb.from('cam_invoices').insert({ property_id: S.propId, cam_year: +d.slice(0, 4), invoice_date: d, vendor: $('mVendor').value.trim(), amount: amt, category_id: $('mCat').value, description: $('mDesc').value.trim() || null, status: 'confirmed', source: 'manual' }), `Added — ${fmt(amt)} counted`);
      logAct('add_manual', { vendor: $('mVendor').value, amount: amt });
      await loadProperty(); renderAdd();
    } finally { if ($('mSave')) $('mSave').disabled = false; }
  };
}

async function pdfText(file) {
  try { const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; let t = '';
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) { const c = await (await pdf.getPage(p)).getTextContent(); t += c.items.map((i) => i.str).join(' ') + '\n'; } return t; } catch (e) { return ''; }
}
function vendorFromName(name) { return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\b\d{6,8}\b/g, '').replace(/\s+/g, ' ').trim(); }

async function handleFiles(files) {
  if (!files.length) return; const log = $('uploadLog');
  for (const f of files) {
    const line = document.createElement('div'); line.className = 'log'; line.textContent = 'Saving ' + f.name + '…'; log.prepend(line);
    if (!(/pdf|image\//.test(f.type) || /\.(pdf|jpe?g|png|heic|webp)$/i.test(f.name))) { line.innerHTML = `✕ <b>${esc(f.name)}</b> skipped — only PDFs and photos can be added.`; continue; }
    try {
      const path = `${S.propId}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, '_')}`;
      await must(sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream' }));
      const text = f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? await pdfText(f) : '';
      const fields = E.extractFields(text + ' ' + f.name);
      const rule = E.suggestCategory(S.rules, f.name + ' ' + text, fields.amount);
      const vendor = rule ? titleCase(rule.match) : vendorFromName(f.name);
      const date = fields.date || new Date().toISOString().slice(0, 10);
      const row = { property_id: S.propId, cam_year: +date.slice(0, 4), invoice_date: date, vendor, amount: fields.amount, category_id: rule ? rule.category_id : null,
        description: rule ? rule.description : null, status: 'needs_review', source: 'upload', file_path: path, file_name: f.name, confidence: rule && fields.amount ? 0.6 : 0.2,
        notes: text ? null : 'No text layer found (scan or photo) — please fill in the details.' };
      const ins = await must(sb.from('cam_invoices').insert(row).select().single());
      line.innerHTML = `<b>${esc(f.name)}</b> saved — ${esc(vendor)} · ${fields.amount != null ? fmt(fields.amount) : 'amount ?'} · ${esc(catName(row.category_id))}. <span class="muted">Checking with Claude…</span>`;
      const ai = await aiExtract(ins.id, path);
      line.innerHTML = `✓ <b>${esc(f.name)}</b> saved${ai ? ' and read by Claude' : ''} — now waiting under <a href="#" onclick="go('review');return false">To review</a>.`;
      logAct('upload', { file: f.name });
    } catch (e) { line.innerHTML = `✕ <b>${esc(f.name)}</b> could not be saved: <span class="owe">${esc(e.message || e)}</span>`; }
  }
  await loadProperty(); render();
}
function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

/* Optional: the cam-extract edge function reads the file with Claude when an API key is configured. */
async function aiExtract(invoiceId, path) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_URL + '/functions/v1/cam-extract', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_KEY },
      body: JSON.stringify({ invoice_id: invoiceId, file_path: path, property_id: S.propId }) });
    if (!res.ok) return false; const j = await res.json(); return !!j.updated;
  } catch (e) { return false; }
}

/* ---------- review ---------- */
async function signedUrl(path) { const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600); return data && data.signedUrl; }
function reviewFields(card) {
  const upd = {}; card.querySelectorAll('[data-f]').forEach((x) => { const f = x.dataset.f; upd[f] = f === 'amount' ? num(x.value) : f === 'cam_year' ? +x.value : x.value || null; });
  if (upd.amount != null && isNaN(upd.amount)) upd.amount = null;
  return upd;
}
function renderReview() {
  const el = $('tab-review'); const rows = S.invoices.filter((i) => i.status === 'needs_review').sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || ''));
  if (!rows.length) { el.innerHTML = '<div class="card"><h2>✓ All caught up</h2><p class="hint" style="margin:6px 0 0">Nothing is waiting for review. New uploads and invoices Claude finds in Google Drive will show up here.</p></div>'; return; }
  let h = `<div class="card"><h2>${rows.length} invoice${rows.length > 1 ? 's' : ''} to check</h2><p class="hint" style="margin:6px 0 ${canWrite() ? '12px' : '0'}">For each one, make sure the date, amount and category are right, then click <b>Confirm</b> so it counts in the totals. Use <b>Not CAM</b> for bills the tenants shouldn't share.</p>${canWrite() ? '<button class="btn" id="confirmAllReady">Confirm every invoice that has a date, amount and category</button>' : ''}</div>`;
  rows.forEach((i) => {
    h += `<div class="rcard" data-id="${i.id}"><div class="thumb" id="th-${i.id}">${i.file_path ? 'Loading preview…' : i.drive_url ? `<a href="${esc(i.drive_url)}" target="_blank" rel="noopener">Open the file in Google Drive</a>` : 'No file attached'}</div><div>
      <div class="row" style="margin-bottom:8px">${statusPill('needs_review')}<b>${esc(i.vendor || 'Unknown vendor')}</b><span class="muted small">${SOURCE_LABEL[i.source] || esc(i.source)}${i.file_name ? ' · ' + esc(i.file_name) : ''}</span></div>
      ${i.notes ? `<div class="note info" style="margin-bottom:10px">${esc(i.notes)}</div>` : ''}
      <div class="form">
        <label>Invoice date<input type="date" data-f="invoice_date" value="${esc(i.invoice_date || '')}"></label>
        <label>Counts toward year<input type="number" data-f="cam_year" value="${esc(i.cam_year)}"></label>
        <label>Vendor<input data-f="vendor" value="${esc(i.vendor || '')}"></label>
        <label>Amount ($)<input data-f="amount" inputmode="decimal" value="${i.amount ?? ''}" placeholder="enter amount"></label>
        <label>Category<select data-f="category_id">${catOptions(i.category_id)}</select></label>
        <label class="wide">Description<input data-f="description" value="${esc(i.description || '')}"></label>
      </div>
      ${canWrite() ? `<div class="row" style="margin-top:12px"><button class="btn good" data-act="confirm">✓ Confirm</button><button class="btn" data-act="exclude">Not CAM</button>${i.file_path ? '<button class="btn" data-act="open">Open file</button>' : ''}<span class="grow"></span><button class="btn danger" data-act="delete">Delete</button></div>` : ''}
    </div></div>`;
  });
  el.innerHTML = h;
  rows.forEach(async (i) => { if (!i.file_path) return; const url = await signedUrl(i.file_path); const th = $('th-' + i.id); if (!th) return; if (!url) { th.textContent = 'Preview unavailable'; return; }
    if (/\.pdf$/i.test(i.file_path)) { try { const pdf = await pdfjsLib.getDocument(url).promise; const pg = await pdf.getPage(1); const vp = pg.getViewport({ scale: 0.4 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; th.innerHTML = ''; th.appendChild(c); } catch (e) { th.textContent = 'PDF (click Open file)'; } }
    else { th.innerHTML = `<img alt="" src="${esc(url)}">`; } });
  el.querySelectorAll('.rcard').forEach((card) => {
    card.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => reviewAct(card, b.dataset.act)));
    // keep "counts toward year" in step with the invoice date
    const d = card.querySelector('[data-f="invoice_date"]'), y = card.querySelector('[data-f="cam_year"]');
    d.addEventListener('change', () => { if (d.value) y.value = d.value.slice(0, 4); });
    // suggest a category when the vendor is typed
    const v = card.querySelector('[data-f="vendor"]'), c = card.querySelector('[data-f="category_id"]'), a = card.querySelector('[data-f="amount"]');
    v.addEventListener('change', () => { if (c.value) return; const r = E.suggestCategory(S.rules, v.value, num(a.value)); if (r) c.value = r.category_id; });
  });
  const all = $('confirmAllReady'); if (all) all.onclick = async () => {
    const ready = [...el.querySelectorAll('.rcard')].map((card) => ({ id: card.dataset.id, upd: reviewFields(card) })).filter((x) => x.upd.category_id && x.upd.amount != null && x.upd.invoice_date);
    if (!ready.length) return toast('None are complete yet — each needs a date, amount and category.');
    all.disabled = true;
    for (const x of ready) await must(sb.from('cam_invoices').update({ ...x.upd, status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', x.id));
    toast(ready.length + ' confirmed'); logAct('confirm_bulk', { count: ready.length }); await loadProperty(); render(); };
}
async function reviewAct(card, act) {
  const id = card.dataset.id; const inv = S.invoices.find((i) => i.id === id);
  if (act === 'open') { const u = await signedUrl(inv.file_path); if (u) window.open(u, '_blank', 'noopener'); return; }
  if (act === 'delete') { if (!confirm('Delete this invoice' + (inv.file_path ? ' and its uploaded file' : '') + '? This can’t be undone.')) return; if (inv.file_path) await sb.storage.from(BUCKET).remove([inv.file_path]); await must(sb.from('cam_invoices').delete().eq('id', id), 'Deleted'); logAct('delete', { vendor: inv.vendor, amount: inv.amount }); await loadProperty(); return render(); }
  const upd = reviewFields(card);
  if (act === 'confirm' && (!upd.category_id || upd.amount == null || !upd.invoice_date)) return toast('Add the date, amount and category first.');
  if (!upd.cam_year && upd.invoice_date) upd.cam_year = +upd.invoice_date.slice(0, 4);
  upd.status = act === 'confirm' ? 'confirmed' : 'excluded'; upd.updated_at = new Date().toISOString();
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  await must(sb.from('cam_invoices').update(upd).eq('id', id), act === 'confirm' ? `Confirmed — ${fmt(upd.amount)} now counted` : 'Marked as not CAM');
  // learn: remember vendor → category when confirmed with no existing rule
  if (act === 'confirm' && upd.vendor && !E.suggestCategory(S.rules, upd.vendor, upd.amount) && canWrite()) {
    await sb.from('cam_vendor_rules').insert({ property_id: S.propId, match: upd.vendor.toLowerCase().slice(0, 40), category_id: upd.category_id, description: upd.description, priority: 3 });
  }
  logAct(act, { vendor: upd.vendor, amount: upd.amount }); await loadProperty(); render();
}

/* ---------- all invoices ---------- */
function renderInvoices() {
  const el = $('tab-invoices'); const f = S.filters;
  const rows = S.invoices.filter((i) => i.cam_year === S.year && (!f.cat || i.category_id === f.cat) && (!f.status || i.status === f.status) &&
    (!f.q || [i.vendor, i.description, i.notes, i.file_name].join(' ').toLowerCase().includes(f.q.toLowerCase()))).sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || ''));
  const tot = rows.filter((i) => i.status === 'confirmed').reduce((s, i) => s + (+i.amount || 0), 0);
  let h = `<div class="card"><h2>All ${S.year} invoices</h2><p class="hint">Every invoice for ${esc(prop().name || '')} in ${S.year}. Only <b>Counted</b> invoices go into the totals. Click Edit to fix one.</p><div class="row noprint" style="margin-bottom:12px"><input id="fQ" class="grow" placeholder="Search vendor or description…" value="${esc(f.q)}">
    <select id="fCat"><option value="">All categories</option>${S.categories.map((c) => `<option value="${c.id}" ${c.id === f.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select id="fStatus"><option value="">Any status</option>${['confirmed', 'needs_review', 'excluded'].map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
    <button class="btn" id="csv">Download for Excel</button></div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Description</th><th class="n">Amount</th><th>Status</th><th>Where it came from</th><th></th></tr></thead><tbody>`;
  rows.forEach((i) => { h += `<tr><td>${fmtDate(i.invoice_date)}</td><td>${esc(i.vendor)}</td><td>${esc(catName(i.category_id))}</td><td>${esc(i.description || '')}</td><td class="n">${i.amount == null ? '—' : fmt(i.amount)}</td>
    <td>${statusPill(i.status)}</td><td class="muted small">${SOURCE_LABEL[i.source] || esc(i.source)}</td>
    <td style="white-space:nowrap">${i.file_path ? `<button class="btn sm" onclick="openFile('${i.id}')">File</button>` : i.drive_url ? `<a class="btn sm" href="${esc(i.drive_url)}" target="_blank" rel="noopener">Drive</a>` : ''} ${canWrite() ? `<button class="btn sm" onclick="editInvoice('${i.id}')">Edit</button>` : ''}</td></tr>`; });
  if (!rows.length) h += `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No invoices match.</td></tr>`;
  h += `<tr class="total"><td colspan="4">${rows.length} invoice${rows.length === 1 ? '' : 's'} shown · total counted</td><td class="n">${fmt(tot)}</td><td colspan="3"></td></tr></tbody></table></div></div>`;
  el.innerHTML = h;
  $('fQ').oninput = (e) => { S.filters.q = e.target.value; clearTimeout(renderInvoices._t); renderInvoices._t = setTimeout(() => { renderInvoices(); $('fQ').focus(); $('fQ').setSelectionRange(9e9, 9e9); }, 250); };
  $('fCat').onchange = (e) => { S.filters.cat = e.target.value; renderInvoices(); };
  $('fStatus').onchange = (e) => { S.filters.status = e.target.value; renderInvoices(); };
  $('csv').onclick = () => { const lines = [['Date', 'Vendor', 'Category', 'Description', 'Amount', 'Status', 'Source']].concat(rows.map((i) => [i.invoice_date, i.vendor, catName(i.category_id), i.description, i.amount, STATUS_LABEL[i.status] || i.status, SOURCE_LABEL[i.source] || i.source]));
    const blob = new Blob(['\ufeff' + lines.map((l) => l.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${prop().name} CAM invoices ${S.year}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
}
async function openFile(id) { const i = S.invoices.find((x) => x.id === id); const u = await signedUrl(i.file_path); if (u) window.open(u, '_blank', 'noopener'); }
function editInvoice(id) {
  const i = S.invoices.find((x) => x.id === id);
  openModal(`<h2 style="margin-top:0">Edit invoice</h2><p class="hint">${esc(SOURCE_LABEL[i.source] || i.source)}${i.file_name ? ' · ' + esc(i.file_name) : ''}</p><div class="form">
    <label>Invoice date<input type="date" id="eDate" value="${esc(i.invoice_date || '')}"></label><label>Counts toward year<input type="number" id="eYear" value="${i.cam_year}"></label>
    <label>Vendor<input id="eVendor" value="${esc(i.vendor || '')}"></label><label>Amount ($)<input id="eAmt" inputmode="decimal" value="${i.amount ?? ''}"></label>
    <label>Category<select id="eCat">${catOptions(i.category_id)}</select></label><label>Status<select id="eStatus">${['confirmed', 'needs_review', 'excluded'].map((s) => `<option value="${s}" ${s === i.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
    <label style="grid-column:1/-1">Description<input id="eDesc" value="${esc(i.description || '')}"></label><label style="grid-column:1/-1">Notes<textarea id="eNotes" rows="2">${esc(i.notes || '')}</textarea></label></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="eSave">Save</button><button class="btn" onclick="closeModal()">Cancel</button><span class="grow"></span><button class="btn danger" id="eDel">Delete</button></div>`);
  $('eDate').addEventListener('change', () => { if ($('eDate').value) $('eYear').value = $('eDate').value.slice(0, 4); });
  $('eSave').onclick = async () => { const amt = num($('eAmt').value); if ($('eStatus').value === 'confirmed' && (amt == null || isNaN(amt) || !$('eCat').value || !$('eDate').value)) return toast('A counted invoice needs a date, amount and category.'); if (!+$('eYear').value) return toast('Enter the year it counts toward.'); await must(sb.from('cam_invoices').update({ invoice_date: $('eDate').value || null, cam_year: +$('eYear').value, vendor: $('eVendor').value, amount: isNaN(amt) ? null : amt, category_id: $('eCat').value || null, status: $('eStatus').value, description: $('eDesc').value || null, notes: $('eNotes').value || null, updated_at: new Date().toISOString() }).eq('id', id), 'Saved'); logAct('edit', { id }); closeModal(); await loadProperty(); render(); };
  $('eDel').onclick = async () => { if (!confirm('Delete this invoice?')) return; if (i.file_path) await sb.storage.from(BUCKET).remove([i.file_path]); await must(sb.from('cam_invoices').delete().eq('id', id), 'Deleted'); logAct('delete', { vendor: i.vendor, amount: i.amount }); closeModal(); await loadProperty(); render(); };
}

/* ---------- report ---------- */
function renderReport() {
  const el = $('tab-report'); const r = calc(); const p = prop();
  if (!r.tenants.length) { el.innerHTML = '<div class="card"><h2>No tenants for ' + S.year + '</h2><p class="hint" style="margin:6px 0 0">No leases are active in ' + S.year + ' for this property. Add leases under Setup.</p></div>'; return; }
  if (!r.tenants.find((t) => t.tenant === S.report.tenant)) S.report.tenant = (r.tenants.find((t) => !t.relatedParty) || r.tenants[0]).tenant;
  const t = r.tenants.find((x) => x.tenant === S.report.tenant); const m = S.report.method;
  const isCur = S.year === new Date().getFullYear();
  const warn = r.warnings.filter((w) => m !== 'current' || !isLeaseOnlyWarning(w));
  let h = `<div class="card noprint"><h2>Year-end statement</h2><p class="hint">Pick the tenant, check the numbers, then click <b>Print / Save as PDF</b> and send it to the tenant.</p><div class="row"><label class="pick">Tenant <select id="rTenant">${r.tenants.map((x) => `<option ${x.tenant === t.tenant ? 'selected' : ''}>${esc(x.tenant)}</option>`).join('')}</select></label>
    <label class="pick">How to split costs <select id="rMethod"><option value="current" ${m === 'current' ? 'selected' : ''}>How we've always billed (workbook)</option><option value="lease" ${m === 'lease' ? 'selected' : ''}>Exactly as the lease is worded</option><option value="compare" ${m === 'compare' ? 'selected' : ''}>Compare both — internal only</option></select></label>
    <span class="grow"></span><button class="btn primary" onclick="window.print()">Print / Save as PDF</button></div>
    ${isCur ? `<div class="note" style="margin:12px 0 0">${S.year} isn't over yet, so this is a draft based on bills so far. Send the final statement after all December bills are in.</div>` : ''}
    ${r.pendingCount ? `<div class="note" style="margin:12px 0 0">${r.pendingCount} invoice${r.pendingCount > 1 ? 's are' : ' is'} still waiting under <a href="#" onclick="go('review');return false">To review</a> and ${r.pendingCount > 1 ? 'are' : 'is'} not included yet.</div>` : ''}
    ${warn.map((w) => `<div class="note" style="margin:12px 0 0">${esc(w)}</div>`).join('')}</div>`;
  if (m === 'compare') { h += compareHtml(t, r); el.innerHTML = h; return wireReport(); }
  const res = t.leases.map((x) => ({ x, c: x[m] }));
  const due = res.reduce((s, y) => s + y.c.due, 0);
  const y0 = `January 1 – December 31, ${S.year}`;
  h += `<div class="stmt"><div class="lh"><div><h1>${S.year} CAM Reconciliation Statement</h1><div class="sub">${esc(p.entity || p.name)}${p.address ? ' · ' + esc(p.address) : ''}</div></div></div>
    <table class="meta"><tr><td style="width:190px">Tenant</td><td><b>${esc(t.tenant)}</b></td></tr><tr><td>Reconciliation period</td><td>${y0}${isCur ? ' (year to date)' : ''}</td></tr>
    <tr><td>Leased square footage</td><td>${t.leases.map((x) => Number(x.space.sqft).toLocaleString() + ' sq ft' + (t.leases.length > 1 ? ' (' + esc(x.space.name) + ')' : '')).join(' + ')}</td></tr>
    <tr><td>Building leasable area</td><td>${Number(r.totalSqft).toLocaleString()} sq ft</td></tr></table>
    <div class="due"><span>${due >= 0 ? `Total ${S.year} CAM true-up due` : `${S.year} CAM credit to tenant`}</span><span>${fmt(Math.abs(due))}</span></div>
    <h2>Building-wide expense summary</h2><table><thead><tr><th>Category</th><th class="n">Budgeted</th><th class="n">Actual</th><th class="n">Difference</th></tr></thead><tbody>
    ${r.groups.filter((g) => g.billable).map((g) => `<tr><td>${esc(g.group)}</td><td class="n">${g.budget == null ? '—' : fmt(g.budget)}</td><td class="n">${fmt(g.actual)}</td><td class="n">${g.difference == null ? '—' : fmt(g.difference)}</td></tr>`).join('')}
    <tr class="total"><td>Total</td><td class="n">${r.buildingTotals.budget == null ? '—' : fmt(r.buildingTotals.budget)}</td><td class="n">${fmt(r.buildingTotals.actual)}</td><td class="n">${r.buildingTotals.difference == null ? '—' : fmt(r.buildingTotals.difference)}</td></tr></tbody></table>
    <h2>${esc(t.tenant)} share calculation</h2>`;
  res.forEach(({ x, c }) => {
    h += `<table><thead><tr><th>${t.leases.length > 1 ? esc(x.space.name) : 'Expense'}</th><th class="n">Building actual</th><th class="n">Tenant share</th><th class="n">Tenant amount</th></tr></thead><tbody>`;
    c.lines.forEach((l) => l.detail.forEach((d) => { h += `<tr><td>${esc(d.category)}</td><td class="n">${fmt(d.total)}</td><td class="n">${(d.share * 100).toFixed(2)}%</td><td class="n">${fmt(d.amount)}</td></tr>`; }));
    if (c.admin) h += `<tr><td>Administrative fee <span class="fine">(${esc(c.adminBasis)})</span></td><td></td><td></td><td class="n">${fmt(c.admin)}</td></tr>`;
    if (c.mgmt) h += `<tr><td>Management fee <span class="fine">(${esc(c.mgmtBasis)})</span></td><td></td><td></td><td class="n">${fmt(c.mgmt)}</td></tr>`;
    h += `<tr class="total"><td>Actual CAM</td><td></td><td></td><td class="n">${fmt(c.actual)}</td></tr><tr><td>Less: CAM billed during ${S.year}</td><td></td><td></td><td class="n">(${fmt(c.budget)})</td></tr>
      <tr class="total"><td>${c.due >= 0 ? 'Amount due' : 'Credit'}</td><td></td><td></td><td class="n">${fmt(c.due)}</td></tr></tbody></table>`;
    if (c.occupancy < 1) h += `<p class="fine">Pro-rated for ${(c.occupancy * 100).toFixed(1)}% of the year occupied.</p>`;
  });
  h += `<p class="fine">${m === 'lease' ? 'Tenant’s proportionate share is the leased square footage divided by the total leasable floor area of the development.' : 'Office building costs are shared by office square footage; insurance and property tax by total building square footage.'} Positive amounts are due from the tenant; negative amounts are credited to the tenant's account.</p>`;
  // supporting detail
  h += `<h2 class="pb">Supporting expense detail</h2>`;
  const conf = S.invoices.filter((i) => i.cam_year === S.year && i.status === 'confirmed');
  const used = new Set(res.flatMap(({ c }) => c.lines.flatMap((l) => l.detail.map((d) => d.category))));
  S.categories.filter((c) => used.has(c.name)).forEach((c) => {
    const rows = conf.filter((i) => i.category_id === c.id).sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || ''));
    if (!rows.length) return;
    h += `<table><thead><tr><th style="width:90px">${esc(c.name)}</th><th>Vendor</th><th>Description</th><th class="n">Amount</th></tr></thead><tbody>${rows.map((i) => `<tr><td>${fmtDate(i.invoice_date)}</td><td>${esc(i.vendor)}</td><td>${esc(i.description || '')}</td><td class="n">${fmt(i.amount)}</td></tr>`).join('')}
      <tr class="total"><td colspan="3">Total ${esc(c.name)}</td><td class="n">${fmt(rows.reduce((s, i) => s + (+i.amount || 0), 0))}</td></tr></tbody></table>`;
  });
  h += `<p class="fine" style="margin-top:18px">Prepared ${new Date().toLocaleDateString('en-US')} · ${esc(p.entity || p.name)}</p></div>`;
  el.innerHTML = h; wireReport();
}
function compareHtml(t, r) {
  let h = `<div class="card"><h2>${esc(t.tenant)} — the two methods side by side</h2><p class="hint">Internal only — don't send this page to the tenant. A positive difference means the lease wording charges more.</p><div class="scroll"><table class="tbl"><thead><tr><th>Space</th><th>Item</th><th class="n">Current method</th><th class="n">Lease wording</th><th class="n">Difference</th></tr></thead><tbody>`;
  t.leases.forEach((x) => {
    const groups = [...new Set([...x.current.lines, ...x.lease.lines].map((l) => l.group))];
    groups.forEach((g) => { const a = (x.current.lines.find((l) => l.group === g) || {}).amount || 0, b = (x.lease.lines.find((l) => l.group === g) || {}).amount || 0; h += `<tr><td>${esc(x.space.name)}</td><td>${esc(g)}</td><td class="n">${fmt(a)}</td><td class="n">${fmt(b)}</td><td class="n">${fmt(b - a)}</td></tr>`; });
    [['Admin fee', 'admin'], ['Management fee', 'mgmt'], ['Actual CAM', 'actual'], ['CAM billed', 'budget'], ['Due', 'due']].forEach(([lbl, k]) => { h += `<tr class="${k === 'due' ? 'total' : ''}"><td>${esc(x.space.name)}</td><td>${lbl}</td><td class="n">${fmt(x.current[k])}</td><td class="n">${fmt(x.lease[k])}</td><td class="n">${fmt(x.lease[k] - x.current[k])}</td></tr>`; });
  });
  h += `</tbody></table></div><p class="muted" style="font-size:12px">Current: ${esc(t.leases[0].current.adminBasis || 'no admin fee')}; ${esc(t.leases[0].current.mgmtBasis || 'no management fee')}.<br>Lease wording: ${esc(t.leases[0].lease.adminBasis || 'no admin fee')}; ${esc(t.leases[0].lease.mgmtBasis || 'no management fee')}.</p></div>`;
  return h;
}
function wireReport() { $('rTenant').onchange = (e) => { S.report.tenant = e.target.value; renderReport(); }; $('rMethod').onchange = (e) => { S.report.method = e.target.value; renderReport(); }; }

/* ---------- settings ---------- */
function renderSettings() {
  const el = $('tab-settings'); const p = prop(); const w = canWrite(); const dis = w ? '' : 'disabled';
  const spOpt = (sel) => S.spaces.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const types = [...new Set(['office', 'warehouse', 'retail', 'other', ...S.spaces.map((s) => s.space_type)])];
  let h = `${w ? '' : '<div class="note info">You have view-only access, so these settings can’t be changed.</div>'}<div class="card"><h2>Property</h2><p class="hint">Basic details. "Total leasable sq ft" is the whole building — it's what each tenant's share is measured against.</p><div class="form">
    <label>Name<input id="pName" value="${esc(p.name)}" ${dis}></label><label>Owner entity<input id="pEntity" value="${esc(p.entity || '')}" ${dis}></label>
    <label style="grid-column:span 2">Address<input id="pAddr" value="${esc(p.address || '')}" ${dis}></label>
    <label>Total leasable sq ft<input id="pSqft" value="${p.total_sqft ?? ''}" ${dis}></label>
    <label>Status<select id="pStatus" ${dis}>${[['active', 'Leased (active)'], ['not_leased', 'Not leased yet'], ['inactive', 'Inactive']].map(([v, l]) => `<option value="${v}" ${v === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label style="grid-column:span 2">Google Drive invoice folder ID (Claude scans this) <input id="pDrive" value="${esc(p.drive_folder_id || '')}" ${dis}></label>
    ${w ? '<button class="btn primary" id="pSave">Save property</button>' : ''}</div></div>`;
  // spaces
  h += `<div class="card"><h2>Spaces</h2><p class="hint">Each suite or area that can be leased, with its square footage.</p><div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Suite</th><th class="n">Sq ft</th><th>Type</th><th></th></tr></thead><tbody>${S.spaces.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.suite || '')}</td><td class="n">${Number(s.sqft).toLocaleString()}</td><td>${esc(s.space_type)}</td><td>${w ? `<button class="btn sm" onclick="editSpace('${s.id}')">Edit</button>` : ''}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">Total of spaces</td><td class="n">${S.spaces.reduce((a, s) => a + Number(s.sqft), 0).toLocaleString()}</td><td colspan="2"></td></tr></tbody></table></div>${w ? '<button class="btn" onclick="editSpace()">+ Add space</button>' : ''}</div>`;
  // categories
  h += `<div class="card"><h2>Expense categories & how they're split</h2><p class="hint">"Split" says which tenants share a cost. "Admin fee applies" means the lease's admin fee is charged on it (not on taxes or insurance).</p><div class="scroll"><table class="tbl"><thead><tr><th>Category</th><th>Statement line</th><th>Split</th><th>Admin fee applies</th><th></th></tr></thead><tbody>${S.categories.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.report_group)}</td><td>${esc(basisLabel(c))}</td><td>${c.admin_fee_eligible ? 'Yes' : 'No'}</td><td>${w ? `<button class="btn sm" onclick="editCategory('${c.id}')">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${w ? '<button class="btn" onclick="editCategory()">+ Add category</button>' : ''}</div>`;
  // budgets
  const groups = [...new Set(S.categories.filter((c) => c.basis !== 'owner').map((c) => c.report_group))];
  h += `<div class="card"><h2>${S.year} building budget</h2><p class="hint">What you expect to spend for the whole building this year, by statement line. Change the year at the top to enter another year. Leave a box empty to remove it.</p><div class="form">${groups.map((g) => { const b = S.budgets.find((x) => x.year === S.year && x.report_group === g); return `<label>${esc(g)}<input data-budget="${esc(g)}" inputmode="decimal" value="${b ? b.amount : ''}" ${dis}></label>`; }).join('')}${w ? '<button class="btn primary" id="bSave">Save budget</button>' : ''}</div></div>`;
  // leases
  h += `<div class="card"><h2>Leases</h2><p class="hint">Enter the CAM each tenant paid during ${S.year} (their monthly CAM × 12) — the year-end statement subtracts it. Rent is only needed for the management fee.</p><div class="scroll"><table class="tbl"><thead><tr><th>Tenant</th><th>Space</th><th>Term</th><th>Method</th><th>Fees</th><th class="n">CAM paid in ${S.year}</th><th class="n">Rent in ${S.year}</th><th></th></tr></thead><tbody>`;
  S.leases.forEach((l) => { const y = S.leaseYears.find((x) => x.lease_id === l.id && x.year === S.year) || {}; const sp = S.spaces.find((s) => s.id === l.space_id) || {};
    h += `<tr><td><b>${esc(l.tenant_name)}</b>${l.related_party ? ' <span class="pill">related party</span>' : ''}</td><td>${esc(sp.name)}</td><td>${fmtDate(l.lease_start)} – ${fmtDate(l.lease_end)}</td><td>${l.method === 'lease' ? 'Lease wording' : 'As always billed'}</td>
      <td>${l.related_party ? '—' : `admin ${l.admin_fee_pct}% · mgmt ${l.mgmt_fee_pct}% ${l.mgmt_fee_mode === 'own_rent' ? 'of own rent' : l.mgmt_fee_mode === 'shared_gross' ? 'of gross rents' : ''}`}</td>
      <td class="n">${y.cam_budget != null ? fmt(y.cam_budget) : '<span class="owe">not entered</span>'}</td><td class="n">${y.rent_total != null ? fmt(y.rent_total) : '—'}</td><td>${w ? `<button class="btn sm" onclick="editLease('${l.id}')">Edit</button>` : ''}</td></tr>`; });
  h += `</tbody></table></div>${w ? '<button class="btn" onclick="editLease()">+ Add lease</button>' : ''}</div>`;
  // rules
  h += `<div class="card"><h2>Auto-sort rules</h2><p class="hint">When an invoice's vendor, file name or text contains the match text, it is filed under that category. Rules are also learned when you confirm an invoice from a new vendor.</p><div class="scroll"><table class="tbl"><thead><tr><th>Match text</th><th>Category</th><th>Default description</th><th>Amount range</th><th class="n">Priority</th><th></th></tr></thead><tbody>${S.rules.map((r) => `<tr><td>${esc(r.match)}</td><td>${esc(catName(r.category_id))}</td><td>${esc(r.description || '')}</td><td>${r.amount_min != null || r.amount_max != null ? `${r.amount_min ?? 0} – ${r.amount_max ?? '∞'}` : ''}</td><td class="n">${r.priority}</td><td>${w ? `<button class="btn sm danger" onclick="delRule('${r.id}')">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${w ? `<div class="form" style="margin-top:10px"><label>Match text<input id="rMatch"></label><label>Category<select id="rCat">${catOptions()}</select></label><label>Description<input id="rDesc"></label><label>Priority<input id="rPri" type="number" value="5"></label><button class="btn" id="rAdd">Add rule</button></div>` : ''}</div>`;
  if (S.role === 'owner') h += `<div class="card"><h2>People with access</h2><p class="hint"><b>Finance</b> can add and edit. <b>View only</b> can look but not change anything. <b>Owner</b> can also manage people and properties.</p><div id="usersBox" class="muted">Loading…</div></div>`;
  el.innerHTML = h;
  if (!w) return;
  $('pSave').onclick = async () => { await must(sb.from('cam_properties').update({ name: $('pName').value, entity: $('pEntity').value || null, address: $('pAddr').value || null, total_sqft: num($('pSqft').value), status: $('pStatus').value, drive_folder_id: $('pDrive').value || null }).eq('id', S.propId), 'Property saved'); S.properties = await must(sb.from('cam_properties').select('*').order('name')); fillSelectors(); };
  $('bSave').onclick = async () => { const inputs = [...document.querySelectorAll('[data-budget]')];
    const bad = inputs.find((x) => x.value.trim() !== '' && isNaN(num(x.value))); if (bad) return toast('“' + bad.value + '” isn’t a number.');
    const rows = inputs.filter((x) => x.value.trim() !== '').map((x) => ({ property_id: S.propId, year: S.year, report_group: x.dataset.budget, amount: num(x.value) }));
    const cleared = inputs.filter((x) => x.value.trim() === '').map((x) => x.dataset.budget);
    if (rows.length) await must(sb.from('cam_budgets').upsert(rows, { onConflict: 'property_id,year,report_group' }));
    if (cleared.length) await must(sb.from('cam_budgets').delete().eq('property_id', S.propId).eq('year', S.year).in('report_group', cleared));
    toast('Budget saved'); await loadProperty(); render(); };
  $('rAdd').onclick = async () => { if (!$('rMatch').value || !$('rCat').value) return toast('Match text and category are required.'); await must(sb.from('cam_vendor_rules').insert({ property_id: S.propId, match: $('rMatch').value.toLowerCase(), category_id: $('rCat').value, description: $('rDesc').value || null, priority: +$('rPri').value || 0 }), 'Rule added'); await loadProperty(); render(); };
  if (S.role === 'owner') renderUsers();
}
function basisLabel(c) {
  if (c.basis === 'building') return 'All spaces by sq ft';
  if (c.basis === 'space_type') return `${c.basis_value} spaces by sq ft`;
  if (c.basis === 'space') return '100% to ' + ((S.spaces.find((s) => s.id === c.basis_value) || {}).name || 'a space');
  return 'Owner pays (not billed)';
}
async function delRule(id) { await must(sb.from('cam_vendor_rules').delete().eq('id', id), 'Rule removed'); await loadProperty(); render(); }
function editSpace(id) {
  const s = S.spaces.find((x) => x.id === id) || { name: '', suite: '', sqft: '', space_type: 'office' };
  openModal(`<h2 style="margin-top:0">${id ? 'Edit' : 'Add'} space</h2><div class="form"><label>Name<input id="sName" value="${esc(s.name)}"></label><label>Suite<input id="sSuite" value="${esc(s.suite || '')}"></label><label>Sq ft<input id="sSqft" value="${s.sqft}"></label>
    <label>Type<input id="sType" list="typeList" value="${esc(s.space_type)}"><datalist id="typeList"><option>office<option>warehouse<option>retail<option>other</datalist></label></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="sSave">Save</button><button class="btn" onclick="closeModal()">Cancel</button>${id ? '<span class="grow"></span><button class="btn danger" id="sDel">Delete</button>' : ''}</div>`);
  $('sSave').onclick = async () => { const row = { property_id: S.propId, name: $('sName').value, suite: $('sSuite').value || null, sqft: num($('sSqft').value), space_type: $('sType').value || 'office' };
    if (!row.name || !row.sqft) return toast('Name and sq ft are required.'); await must(id ? sb.from('cam_spaces').update(row).eq('id', id) : sb.from('cam_spaces').insert(row), 'Saved'); closeModal(); await loadProperty(); render(); };
  if (id) $('sDel').onclick = async () => { if (!confirm('Delete this space and its leases?')) return; await must(sb.from('cam_spaces').delete().eq('id', id), 'Deleted'); closeModal(); await loadProperty(); render(); };
}
function editCategory(id) {
  const c = S.categories.find((x) => x.id === id) || { name: '', report_group: '', basis: 'building', basis_value: null, admin_fee_eligible: false, sort: S.categories.length + 1, active: true };
  const types = [...new Set(S.spaces.map((s) => s.space_type))];
  openModal(`<h2 style="margin-top:0">${id ? 'Edit' : 'Add'} category</h2><div class="form"><label>Name<input id="cName" value="${esc(c.name)}"></label><label>Statement line<input id="cGroup" value="${esc(c.report_group)}" list="grpList"><datalist id="grpList">${[...new Set(S.categories.map((x) => x.report_group))].map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
    <label>Split<select id="cBasis"><option value="building">All spaces by sq ft</option><option value="space_type">One space type by sq ft</option><option value="space">100% to one space</option><option value="owner">Owner pays (not billed)</option></select></label>
    <label>Applies to<select id="cVal"></select></label><label>Admin fee applies<select id="cAdm"><option value="false">No (taxes, insurance)</option><option value="true">Yes (CAM charges)</option></select></label><label>Order<input id="cSort" type="number" value="${c.sort}"></label></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="cSave">Save</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
  $('cBasis').value = c.basis; $('cAdm').value = String(!!c.admin_fee_eligible);
  const fillVal = () => { const b = $('cBasis').value; $('cVal').innerHTML = b === 'space_type' ? types.map((t) => `<option ${t === c.basis_value ? 'selected' : ''}>${esc(t)}</option>`).join('') : b === 'space' ? S.spaces.map((s) => `<option value="${s.id}" ${s.id === c.basis_value ? 'selected' : ''}>${esc(s.name)}</option>`).join('') : '<option value="">—</option>'; };
  fillVal(); $('cBasis').onchange = fillVal;
  $('cSave').onclick = async () => { const row = { property_id: S.propId, name: $('cName').value, report_group: $('cGroup').value || $('cName').value, basis: $('cBasis').value, basis_value: $('cVal').value || null, admin_fee_eligible: $('cAdm').value === 'true', sort: +$('cSort').value || 0 };
    if (!row.name) return toast('Name is required.'); await must(id ? sb.from('cam_categories').update(row).eq('id', id) : sb.from('cam_categories').insert(row), 'Saved'); closeModal(); await loadProperty(); render(); };
}
function editLease(id) {
  const l = S.leases.find((x) => x.id === id) || { tenant_name: '', space_id: (S.spaces[0] || {}).id, method: 'current', admin_fee_pct: 0, mgmt_fee_mode: 'none', mgmt_fee_pct: 0, related_party: false };
  const y = S.leaseYears.find((x) => x.lease_id === id && x.year === S.year) || {};
  openModal(`<h2 style="margin-top:0">${id ? 'Edit' : 'Add'} lease</h2><div class="form">
    <label>Tenant<input id="lTen" value="${esc(l.tenant_name)}"></label><label>Tenant email<input id="lEmail" value="${esc(l.tenant_email || '')}"></label>
    <label>Space<select id="lSpace">${S.spaces.map((s) => `<option value="${s.id}" ${s.id === l.space_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>Start<input type="date" id="lStart" value="${esc(l.lease_start || '')}"></label><label>End<input type="date" id="lEnd" value="${esc(l.lease_end || '')}"></label>
    <label>Method for statements<select id="lMethod"><option value="current">As always billed (workbook)</option><option value="lease">Exactly as the lease is worded</option></select></label>
    <label>Related party<select id="lRel"><option value="false">No</option><option value="true">Yes (no fees)</option></select></label>
    <label>Admin fee %<input id="lAdm" value="${l.admin_fee_pct}"></label>
    <label>Management fee<select id="lMode"><option value="none">None</option><option value="own_rent">% of this tenant's rent</option><option value="shared_gross">% of building gross rents × share</option></select></label>
    <label>Management fee %<input id="lMg" value="${l.mgmt_fee_pct}"></label>
    <label>${S.year} CAM billed / collected<input id="lBud" value="${y.cam_budget ?? ''}"></label><label>${S.year} base rent (total)<input id="lRent" value="${y.rent_total ?? ''}"></label>
    <label style="grid-column:1/-1">Notes<textarea id="lNotes" rows="2">${esc(l.notes || '')}</textarea></label></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="lSave">Save</button><button class="btn" onclick="closeModal()">Cancel</button>${id ? '<span class="grow"></span><button class="btn danger" id="lDel">Delete lease</button>' : ''}</div>`);
  $('lMethod').value = l.method; $('lRel').value = String(!!l.related_party); $('lMode').value = l.mgmt_fee_mode;
  $('lSave').onclick = async () => {
    const row = { property_id: S.propId, tenant_name: $('lTen').value, tenant_email: $('lEmail').value || null, space_id: $('lSpace').value, lease_start: $('lStart').value || null, lease_end: $('lEnd').value || null, method: $('lMethod').value, related_party: $('lRel').value === 'true', admin_fee_pct: num($('lAdm').value) || 0, mgmt_fee_mode: $('lMode').value, mgmt_fee_pct: num($('lMg').value) || 0, notes: $('lNotes').value || null };
    if (!row.tenant_name || !row.space_id) return toast('Tenant and space are required.');
    const saved = await must(id ? sb.from('cam_leases').update(row).eq('id', id).select().single() : sb.from('cam_leases').insert(row).select().single());
    if ($('lBud').value !== '' || $('lRent').value !== '') await must(sb.from('cam_lease_years').upsert({ lease_id: saved.id, year: S.year, cam_budget: num($('lBud').value) || 0, rent_total: num($('lRent').value) }, { onConflict: 'lease_id,year' }));
    toast('Lease saved'); closeModal(); await loadProperty(); render(); };
  if (id) $('lDel').onclick = async () => { if (!confirm('Delete this lease?')) return; await must(sb.from('cam_leases').delete().eq('id', id), 'Deleted'); closeModal(); await loadProperty(); render(); };
}
function newPropertyModal() {
  openModal(`<h2 style="margin-top:0">Add property</h2><div class="form"><label>Name<input id="npName" placeholder="e.g. Patel Real Estate"></label><label>Owner entity<input id="npEnt" placeholder="Patel Real Estate LLC"></label>
    <label style="grid-column:span 2">Address<input id="npAddr"></label><label>Total leasable sq ft<input id="npSqft"></label><label>Status<select id="npStatus"><option value="not_leased">Not leased yet</option><option value="active">Leased (active)</option></select></label>
    <label style="grid-column:1/-1"><span><input type="checkbox" id="npCopy" checked> Start with the same expense categories as ${esc(prop().name || 'the current property')}</span></label></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="npSave">Create</button><button class="btn" onclick="closeModal()">Cancel</button></div>`);
  $('npSave').onclick = async () => {
    if (!$('npName').value) return toast('Name is required.');
    const p = await must(sb.from('cam_properties').insert({ name: $('npName').value, entity: $('npEnt').value || null, address: $('npAddr').value || null, total_sqft: num($('npSqft').value), status: $('npStatus').value }).select().single());
    if ($('npCopy').checked) { const cats = S.categories.filter((c) => c.basis !== 'space').map((c) => ({ property_id: p.id, name: c.name, report_group: c.report_group, basis: c.basis, basis_value: c.basis_value, admin_fee_eligible: c.admin_fee_eligible, sort: c.sort }));
      if (cats.length) await must(sb.from('cam_categories').insert(cats)); }
    S.properties = await must(sb.from('cam_properties').select('*').order('name')); S.propId = p.id; closeModal(); await loadProperty(); go('settings'); toast('Property created — add its spaces next.');
  };
}
async function renderUsers() {
  const box = $('usersBox'); const { data } = await sb.from('cam_users').select('*').order('email');
  box.innerHTML = `<table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>${(data || []).map((u) => `<tr><td>${esc(u.name || '')}</td><td>${esc(u.email)}</td><td>${({ owner: 'Owner', finance: 'Finance', viewer: 'View only' })[u.role] || esc(u.role)}</td><td>${u.active ? 'Yes' : 'No'}</td><td>${u.user_id !== S.me.user_id ? `<button class="btn sm" onclick="toggleUser('${u.user_id}',${!u.active})">${u.active ? 'Turn off' : 'Turn on'}</button>` : ''}</td></tr>`).join('')}</tbody></table>
    <div class="form" style="margin-top:10px"><label>Email<input id="uEmail" type="email"></label><label>Name<input id="uName"></label><label>Role<select id="uRole"><option value="finance">Finance (can add & edit)</option><option value="viewer">View only</option><option value="owner">Owner</option></select></label><button class="btn" id="uAdd">Give access</button></div>
    <p class="muted" style="font-size:12px">People who already sign in to Sonaya tools get access right away. New people get an invitation email to set a password.</p>`;
  $('uAdd').onclick = async () => {
    if (!/^\S+@\S+\.\S+$/.test($('uEmail').value.trim())) return toast('Enter a valid email address.');
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_URL + '/functions/v1/cam-users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_KEY }, body: JSON.stringify({ email: $('uEmail').value.trim(), name: $('uName').value.trim(), role: $('uRole').value, redirect_to: location.origin + location.pathname }) });
    const j = await res.json().catch(() => ({})); if (!res.ok) return toast(j.error || 'Could not add user', 5000); toast(j.invited ? 'Invitation sent' : 'Access granted'); renderUsers(); };
}
async function toggleUser(uid, on) { await must(sb.from('cam_users').update({ active: on }).eq('user_id', uid), 'Updated'); renderUsers(); }

sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.me) location.reload(); if (ev === 'PASSWORD_RECOVERY') setPasswordPrompt(); });
function setPasswordPrompt() {
  openModal(`<h2 style="margin-top:0">Set your password</h2><div class="form"><label>New password<input type="password" id="npw" minlength="8"></label><button class="btn primary" id="npwSave">Save</button></div>`);
  $('npwSave').onclick = async () => { const { error } = await sb.auth.updateUser({ password: $('npw').value }); if (error) return toast(error.message, 5000); closeModal(); toast('Password saved'); boot(); };
}
if (/type=(invite|recovery)/.test(location.hash)) setTimeout(setPasswordPrompt, 800);
boot();
