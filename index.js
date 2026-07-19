import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { hydrate, portalSupabaseConfig } from './portal.js';

// The portal derives invoiceMonth/cashMonth via new Date(iso).getMonth() in the browser's
// local time (UTC+4). Pin the server to UTC so a west-of-UTC host can't shift a 1st-of-month
// date back a month. UTC is safe: it's east of nothing and matches the portal's month math.
process.env.TZ = process.env.TZ || 'UTC';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DRY_RUN = process.env.DRY_RUN === '1';

// Supabase config: env vars win; otherwise extracted from the portal's own source.
const SB = {
  url: process.env.SUPABASE_URL || null,
  key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || null,
};
async function ensureSB() {
  if (!SB.url || !SB.key) {
    const c = await portalSupabaseConfig();
    SB.url = SB.url || c.url;
    SB.key = SB.key || c.key;
  }
  if (!SB.url || !SB.key) throw new Error('Could not resolve Supabase config from env or portal HTML');
  return SB;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function sbHeaders() {
  const { key } = await ensureSB();
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function sbGet() {
  const { url } = await ensureSB();
  const res = await fetch(`${url}/rest/v1/forecast_data?id=eq.1&select=*`, { headers: await sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${await res.text()}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('forecast_data row id=1 not found');
  return rows[0];
}

// Patches ONLY the given columns — never the whole state — so a concurrent
// portal session editing a different column is never clobbered.
async function sbPatch(cols) {
  const payload = { ...cols, updated_at: new Date().toISOString(), updated_by: 'claude-mcp' };
  if (DRY_RUN) {
    console.log('[DRY RUN] PATCH forecast_data:', Object.keys(cols).join(', '));
    return '[DRY RUN — no data written] ';
  }
  const { url } = await ensureSB();
  const res = await fetch(`${url}/rest/v1/forecast_data?id=eq.1`, {
    method: 'PATCH',
    headers: { ...(await sbHeaders()), Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${await res.text()}`);
  return '';
}

async function commentsRequest(method, query, body) {
  const { url } = await ensureSB();
  const res = await fetch(`${url}/rest/v1/comments${query}`, {
    method,
    headers: { ...(await sbHeaders()), ...(method !== 'GET' ? { Prefer: 'return=minimal' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const msg = await res.text();
    if (msg.includes('PGRST205') || msg.includes('schema cache')) {
      throw new Error('The comments table is not accessible with the anon key — set SUPABASE_SERVICE_KEY (Supabase dashboard → Settings → API → service_role) to enable comment tools.');
    }
    throw new Error(`comments ${method} failed: ${msg}`);
  }
  return method === 'GET' ? res.json() : null;
}

// ── Headless portal session ──────────────────────────────────────────────────

async function withPortal(entity = 'conso') {
  const row = await sbGet();
  const p = await hydrate(row);
  p.setEntity(entity);
  return { row, p };
}

// Build the actuals_snap to persist by overlaying the sandbox's rebuilt snap onto the cloud copy.
// Fields the tools actually change (_glMappings, _userRows, a freshly imported entity) come from
// the sandbox and win; any imported entity that a partial hydration replay failed to reconstruct
// is preserved from the cloud instead of being deleted. `missing` reports any such gaps.
function mergedActualsSnap(cloudRow, p) {
  const cloudSnap = cloudRow.actuals_snap || {};
  const newSnap = p.readStore('actuals_snap') || {};
  const newKeys = new Set(Object.keys(newSnap).filter(k => k.startsWith('actuals_')));
  const missing = Object.keys(cloudSnap).filter(k => k.startsWith('actuals_') && !newKeys.has(k));
  return { snap: { ...cloudSnap, ...newSnap }, missing };
}

const $ = n => (n < 0 ? `($${Math.abs(Math.round(n)).toLocaleString('en-US')})` : `$${Math.round(n).toLocaleString('en-US')}`);
const fmtM = m => m; // 'Mon YYYY' as-is; kept as a hook if short-form display is wanted later

// Footer appended to every tool response. Override the wording with the RESPONSE_FOOTER env var
// (no code change / redeploy of logic needed — just update the Railway variable).
const FOOTER = process.env.RESPONSE_FOOTER ||
  "For details, ping Karan on Slack or check Xero. This tool's data may not always be the latest — if any figure looks off, ask the team to refresh it.";
const text = t => ({ content: [{ type: 'text', text: `${t}\n\n---\n_${FOOTER}_` }] });

const ENTITY = z.enum(['conso', 'bh', 'bc']).optional().describe("Entity view: 'conso' (default, consolidated), 'bh' (Braveheart), 'bc' (Bravecore)");
// Same id shape as the portal's modal, plus a per-batch counter so rows added in one bulk
// call can never collide on the shared Date.now() (which would let one delete remove both).
const NEW_ID = `Date.now().toString(36)+(_i).toString(36)+Math.random().toString(36).slice(2,6)`;
const money = z.number().finite(); // rejects NaN/Infinity, which JSON.stringify would silently turn into null

// One McpServer per session (the SDK allows a single transport per instance).
function buildServer() {
const server = new McpServer({ name: 'indexed-fpa', version: '2.0.0' });

// ═══════════════════════════════ READ TOOLS ══════════════════════════════════

server.tool(
  'get_dashboard_metrics',
  'All dashboard KPIs exactly as the portal computes them: closing cash, AR, YTD inflow/outflow/net, founder payments, Founder Cash Earnings, Dec closing forecast, revenue/GP/adj-net P&L metrics, 2026 full-year revenue, and liabilities.',
  { entity: ENTITY },
  async ({ entity }) => {
    const { p } = await withPortal(entity || 'conso');
    const m = p.get(`(function(){
      const d=getD();
      const ytdIn=d.in.reduce(function(s,v){return s+v;},0), ytdOut=d.out.reduce(function(s,v){return s+v;},0);
      const founderPmt=getFounderPayments();
      const decClose=getDecClosingBalance();
      const pl=getPL(), bs=getBSMetrics();
      const idx=FCST_MONTHS.findIndex(function(x){return x.startsWith('Dec');});
      const fcstRevTotal=FCST_MONTHS.slice(0, idx+1||undefined).reduce(function(s,x){return s+getFcastInflow(x);},0);
      return { actualMonths:E.slice(), fcstMonths:FCST_MONTHS.slice(), openingJan:d.open,
        closingCash:d.close[d.close.length-1], monthlyClosing:d.close, ar:bs.ar,
        ytdInflow:ytdIn, ytdOutflow:ytdOut, netMovement:ytdIn-ytdOut,
        founderPayments:founderPmt, adjNetMovement:ytdIn-ytdOut+founderPmt,
        decClosingForecast:decClose, founderCashEarnings:decClose-d.open+founderPmt,
        pl:pl, liabilities:{accountsPayable:bs.ap, accruals:bs.accruals, directorsLoanAcct:bs.dirLoan, loanFromDirector:bs.loanDir},
        fullYearRev2026:pl.ytdRev+fcstRevTotal };
    })()`);
    const lines = [
      `## Dashboard — ${(entity || 'conso').toUpperCase()}`,
      `Actuals: ${m.actualMonths[0]}–${m.actualMonths[m.actualMonths.length - 1]} 2026 · Forecast: ${m.fcstMonths[0]}–${m.fcstMonths[m.fcstMonths.length - 1]}`,
      '',
      `**Closing cash balance:** ${$(m.closingCash)} (${m.actualMonths[m.actualMonths.length - 1]} 2026)`,
      `**Accounts receivable:** ${$(m.ar)}`,
      `**YTD inflow:** ${$(m.ytdInflow)} · **YTD outflow:** ${$(m.ytdOutflow)} · **Net:** ${$(m.netMovement)}`,
      `**Founder payments (Jan–Dec):** ${$(m.founderPayments)}`,
      `**Founder cash earnings:** ${$(m.founderCashEarnings)} (Dec close ${$(m.decClosingForecast)} − Jan open ${$(m.openingJan)} + founder payments)`,
      '',
      `**2026 revenue (YTD + forecast to Dec):** ${$(m.fullYearRev2026)}`,
      `**YTD revenue:** ${$(m.pl.ytdRev)} · **YTD gross profit:** ${$(m.pl.ytdGP)} (${(m.pl.gpPct * 100).toFixed(1)}%)`,
      `**Adj. net profit:** ${$(m.pl.adjNet)} (${(m.pl.adjNetPct * 100).toFixed(1)}%)`,
      '',
      `**Liabilities:** AP ${$(m.liabilities.accountsPayable)} · Accruals ${$(m.liabilities.accruals)} · Directors loan ${$(m.liabilities.directorsLoanAcct)} · Loan from director ${$(m.liabilities.loanFromDirector)}`,
      '',
      `Monthly closing: ${m.actualMonths.map((mo, i) => `${mo} ${$(m.monthlyClosing[i])}`).join(' · ')}`,
    ];
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_cf_statement',
  'Cash flow statement per month — opening, inflow, outflow, net movement, FX, closing — actuals plus chained forecast, identical to the portal CF table.',
  {
    entity: ENTITY,
    mode: z.enum(['hybrid', 'actuals']).optional().describe("'hybrid' (default): actuals + forecast columns. 'actuals': actual months only."),
  },
  async ({ entity, mode }) => {
    const { p } = await withPortal(entity || 'conso');
    if (mode === 'actuals') p.run(`cfMode='actuals'; try{renderCF()}catch(_){};`);
    const s = p.get(`(function(){
      const d=getD();
      let cfActMonths,cfFcstMonths,actIn,actOut,actClose,actFX,actOpen;
      if(cfMode==='hybrid'&&E.length>1){
        cfActMonths=E.slice(0,-1);
        cfFcstMonths=[E[E.length-1]+' '+FCST_YEAR].concat(FCST_MONTHS);
        actIn=d.in.slice(0,cfActMonths.length);actOut=d.out.slice(0,cfActMonths.length);
        actClose=d.close.slice(0,cfActMonths.length);actFX=d.fx.slice(0,cfActMonths.length);actOpen=d.open;
      }else{
        cfActMonths=E.slice();cfFcstMonths=[];
        actIn=d.in.slice();actOut=d.out.slice();actClose=d.close.slice();actFX=d.fx.slice();actOpen=d.open;
      }
      const fcastIn=cfFcstMonths.map(function(m){return getFcastInflow(m);});
      const fcastOut=cfFcstMonths.map(function(m){return getFcastOutflow(m);});
      const rows=[];
      cfActMonths.forEach(function(m,i){rows.push({month:m+' '+FCST_YEAR,type:'actual',opening:i===0?actOpen:actClose[i-1],inflow:actIn[i],outflow:actOut[i],net:actIn[i]-actOut[i],fx:actFX[i]||0,closing:actClose[i]});});
      let run=actClose.length?actClose[actClose.length-1]:actOpen;
      cfFcstMonths.forEach(function(m,fi){const op=run;run+=fcastIn[fi]-fcastOut[fi];rows.push({month:m,type:'forecast',opening:op,inflow:fcastIn[fi],outflow:fcastOut[fi],net:fcastIn[fi]-fcastOut[fi],fx:0,closing:run});});
      return {mode:cfMode,rows:rows,ytdIn:actIn.reduce(function(s,v){return s+v;},0),ytdOut:actOut.reduce(function(s,v){return s+v;},0)};
    })()`);
    const lines = [
      `## Cash flow statement — ${(entity || 'conso').toUpperCase()} (${s.mode})`,
      '',
      '| Month | | Opening | Inflow | Outflow | Net | Closing |',
      '|---|---|---|---|---|---|---|',
      ...s.rows.map(r => `| ${r.month} | ${r.type === 'actual' ? 'A' : 'F'} | ${$(r.opening)} | ${$(r.inflow)} | ${$(r.outflow)} | ${$(r.net)} | **${$(r.closing)}** |`),
      '',
      `YTD actuals: inflow ${$(s.ytdIn)}, outflow ${$(s.ytdOut)}, net ${$(s.ytdIn - s.ytdOut)}`,
    ];
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_cf_groups',
  'Cash flow broken down by display group (the drill-down level of the CF statement): per-month amounts per client/vendor group. In hybrid mode (default) the newest actual month is shown as forecast from the AR/AP pipeline, exactly as the portal CF table splits it.',
  {
    entity: ENTITY,
    direction: z.enum(['inflow', 'outflow']).describe('Which side of the cash flow'),
    mode: z.enum(['hybrid', 'actuals']).optional().describe("'hybrid' (default) splits the newest month as forecast; 'actuals' shows all GL actual months."),
    include_forecast: z.boolean().optional().describe('Include forecast months from the AR/AP pipeline (default true)'),
  },
  async ({ entity, direction, mode, include_forecast }) => {
    const { p } = await withPortal(entity || 'conso');
    const isIn = direction === 'inflow';
    const E = p.get('E');
    const FCST = p.get('FCST_MONTHS');
    const FY = p.get('FCST_YEAR');
    // Mirror renderCFTable: hybrid holds back the last actual month and shows it as a forecast column.
    const hybrid = mode !== 'actuals' && E.length > 1;
    const actMonths = hybrid ? E.slice(0, -1) : E.slice();
    const fcstMonths = include_forecast === false ? [] : (hybrid ? [`${E[E.length - 1]} ${FY}`, ...FCST] : FCST);
    const act = p.get(`buildCFGroups(${isIn})`);
    const fcst = fcstMonths.length ? p.get(`buildFcastCFGroups(${isIn}, ${JSON.stringify(fcstMonths)})`) : [];
    const lines = [`## ${isIn ? 'Cash inflow' : 'Cash outflow'} by group — ${(entity || 'conso').toUpperCase()}`, ''];
    lines.push(`**Actuals (${actMonths[0]}–${actMonths[actMonths.length - 1]} ${FY}):**`);
    act.forEach(g => {
      const tot = actMonths.reduce((s, m) => s + (g.vals[m] || 0), 0);
      if (!tot) return;
      lines.push(`- **${g.group}**: ${$(tot)} — ${actMonths.filter(m => g.vals[m]).map(m => `${m} ${$(g.vals[m])}`).join(', ')}`);
    });
    if (fcst.length) {
      lines.push('', `**Forecast (${fcstMonths[0]}–${fcstMonths[fcstMonths.length - 1]}):**`);
      fcst.forEach(g => {
        const tot = fcstMonths.reduce((s, m) => s + (g.vals[m] || 0), 0);
        if (!tot) return;
        lines.push(`- **${g.group}**: ${$(tot)} — ${fcstMonths.filter(m => g.vals[m]).map(m => `${fmtM(m)} ${$(g.vals[m])}`).join(', ')}`);
      });
    }
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_cf_transactions',
  'Transaction-level drill-down for an actual month: every GL cash transaction with date, contact, entity, amount, resolved display group, any override, and its tx_key (used by set_cf_override).',
  {
    entity: ENTITY,
    month: z.string().describe("Actual month, short name e.g. 'Jul'"),
    direction: z.enum(['inflow', 'outflow']),
    group: z.string().optional().describe('Only transactions resolving to this display group'),
  },
  async ({ entity, month, direction, group }) => {
    const { p } = await withPortal(entity || 'conso');
    const txs = p.get(`(function(mo,isIn,grpF){
      const merged=getMergedMap(); const out=[];
      const list=isIn?(BH_IN_D[mo]||[]).concat(BC_IN_D[mo]||[]):(BH_OUT_D[mo]||[]).concat(BC_OUT_D[mo]||[]);
      list.forEach(function(tx){
        if(ent!=='conso'&&tx.entity!==ent.toUpperCase())return;
        if(!isIn&&isFee(tx.contact))return;
        const k=(tx.date||'')+'||'+tx.contact+'||'+tx.entity+'||'+(tx.account||'');
        const grp=CF_TX_OVERRIDES[k]||(merged[tx.contact+'||'+tx.entity]||{}).group||tx.contact;
        if(grpF&&grp!==grpF)return;
        out.push({date:tx.date||'',contact:tx.contact,entity:tx.entity,amount:tx.amt,fee:tx.fee||0,account:tx.account||'',group:grp,override:CF_TX_OVERRIDES[k]||null,nettedAgainst:CF_NET_OVERRIDES[k]===true?tx.contact:(CF_NET_OVERRIDES[k]||null),tx_key:k});
      });
      return out;
    })(${JSON.stringify(month)}, ${direction === 'inflow'}, ${JSON.stringify(group || null)})`);
    if (!txs.length) return text(`No ${direction} transactions for ${month}${group ? ` in group "${group}"` : ''}. (Only actual months have transactions — check E via get_dashboard_metrics.)`);
    const total = txs.reduce((s, t) => s + t.amount, 0);
    return text([
      `## ${month} ${direction} — ${txs.length} transactions, ${$(total)}`,
      '',
      ...txs.map(t => `- ${t.date} · **${t.contact}** (${t.entity}) ${$(t.amount)}${t.fee ? ` (fee ${$(t.fee)})` : ''} → group: ${t.group}${t.override ? ' (overridden)' : ''}${t.nettedAgainst ? ` · netted against ${t.nettedAgainst}` : ''}\n  tx_key: \`${t.tx_key}\``),
    ].join('\n'));
  }
);

server.tool(
  'get_bank_breakdown',
  'Bank account balance breakdown per month per entity, as shown on the CF tab.',
  {},
  async () => {
    const { p } = await withPortal('conso');
    const d = p.get(`({months:E.slice(), bh:BH_BANKS, bc:BC_BANKS})`);
    const lines = ['## Bank account breakdown', '', `| Account | Entity | ${d.months.join(' | ')} |`, `|---|---|${d.months.map(() => '---').join('|')}|`];
    for (const [ent2, banks] of [['BH', d.bh], ['BC', d.bc]]) {
      for (const [name, vals] of Object.entries(banks)) {
        lines.push(`| ${name} | ${ent2} | ${d.months.map((_, i) => $(vals[i] || 0)).join(' | ')} |`);
      }
    }
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_financials',
  'Balance sheet or P&L rows exactly as imported from Xero (the Financials tab): every line with monthly values and section.',
  {
    entity: z.enum(['bh', 'bc']).describe('bh = Braveheart, bc = Bravecore'),
    statement: z.enum(['bs', 'pl']).describe('bs = Balance Sheet, pl = Profit & Loss'),
  },
  async ({ entity, statement }) => {
    const { p } = await withPortal('conso');
    const fin = p.get(`(window._importedFin||{})[${JSON.stringify(entity + '_' + statement)}] || null`);
    if (!fin) return text(`No imported ${statement.toUpperCase()} for ${entity.toUpperCase()}. Import it on the portal's Import tab or via import_xero_data.`);
    const lines = [
      `## ${entity.toUpperCase()} ${statement === 'bs' ? 'Balance Sheet' : 'P&L'} (${fin.months.join(', ')})`,
      '',
      `| Line | ${fin.months.join(' | ')} |`,
      `|---|${fin.months.map(() => '---').join('|')}|`,
    ];
    fin.rows.forEach(r => {
      if (r.type === 'h' || r.type === 'sh') { lines.push(`| **${r.label.toUpperCase()}** | ${fin.months.map(() => '').join(' | ')} |`); return; }
      const vals = fin.months.map(m => (r.vals && r.vals[m] !== undefined ? $(r.vals[m]) : '—')).join(' | ');
      lines.push(`| ${r.type === 't' || r.type === 'gt' ? '**' + r.label + '**' : r.label} | ${vals} |`);
    });
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_ar',
  'AR pipeline rows (same as the AR Pipeline tab) with all fields including row id — use ids with update_ar_rows / delete_ar_rows. Filterable like the portal.',
  {
    client: z.string().optional().describe('Substring match on client name'),
    entity: z.enum(['BH', 'BC']).optional(),
    cash_month: z.string().optional().describe("e.g. 'Aug 2026'"),
    invoice_month: z.string().optional(),
    status: z.enum(['Draft', 'Invoiced', 'Partial', 'Paid', 'Overdue']).optional(),
    invoice_type: z.enum(['Retainer', 'One-time']).optional(),
  },
  async (f) => {
    const row = await sbGet();
    const rows = (row.ar_fcst || []).filter(r =>
      (!f.client || (r.client || '').toLowerCase().includes(f.client.toLowerCase())) &&
      (!f.entity || r.entity === f.entity) &&
      (!f.cash_month || r.cashMonth === f.cash_month) &&
      (!f.invoice_month || r.invoiceMonth === f.invoice_month) &&
      (!f.status || r.status === f.status) &&
      (!f.invoice_type || r.invoiceType === f.invoice_type)
    );
    if (!rows.length) return text('No AR rows match those filters.');
    const totAmt = rows.reduce((s, r) => s + (r.usdValue || r.amount || 0), 0);
    const totCash = rows.reduce((s, r) => s + (r.cash || 0), 0);
    return text([
      `## AR pipeline — ${rows.length} rows · USD value ${$(totAmt)} · expected cash ${$(totCash)}`,
      '',
      ...rows.map(r => `- \`${r.id}\` **${r.client}** (${r.entity}) ${r.status} · inv ${r.invoiceMonth || '—'} → cash ${r.cashMonth || '—'} · ${$(r.amount || 0)} ${r.currency || 'USD'}${r.fx && r.fx !== 1 ? ` @ ${r.fx}` : ''} = ${$(r.usdValue || 0)} → cash ${$(r.cash || 0)}${r.fee ? ` (fee ${$(r.fee)})` : ''}${r.notes ? ` · "${r.notes}"` : ''}`),
    ].join('\n'));
  }
);

server.tool(
  'get_ap',
  'AP schedule rows (same as the AP tab) with row ids for update_ap_rows / delete_ap_rows. Filterable like the portal.',
  {
    vendor: z.string().optional().describe('Substring match on vendor'),
    entity: z.enum(['BH', 'BC']).optional(),
    cash_month: z.string().optional(),
    spend_type: z.enum(['Variable', 'Fixed']).optional(),
    category: z.enum(['COS', 'OPEX', 'TAX']).optional(),
  },
  async (f) => {
    const row = await sbGet();
    const rows = (row.ap_fcst || []).filter(r =>
      (!f.vendor || (r.vendor || '').toLowerCase().includes(f.vendor.toLowerCase())) &&
      (!f.entity || r.entity === f.entity) &&
      (!f.cash_month || r.cashMonth === f.cash_month) &&
      (!f.spend_type || r.spendType === f.spend_type) &&
      (!f.category || r.expenseCategory === f.category)
    );
    if (!rows.length) return text('No AP rows match those filters.');
    const tot = rows.reduce((s, r) => s + (r.amount || 0), 0);
    return text([
      `## AP schedule — ${rows.length} rows · total ${$(tot)}`,
      '',
      ...rows.map(r => `- \`${r.id}\` **${r.vendor}** (${r.entity}) · work ${r.workMonth || '—'} → cash ${r.cashMonth || '—'} · ${$(r.amount || 0)} · ${r.spendType || '—'}/${r.expenseCategory || '—'}${r.paymentMode ? ` · ${r.paymentMode}` : ''}${r.notes ? ` · "${r.notes}"` : ''}`),
    ].join('\n'));
  }
);

server.tool(
  'get_client_history',
  'Payment history for a client: collection rate (cash received vs invoiced) and average delay from invoice month to cash month, from paid AR rows.',
  { client: z.string().describe('Client name (partial match)') },
  async ({ client }) => {
    const row = await sbGet();
    const all = (row.ar_fcst || []).filter(r => (r.client || '').toLowerCase().includes(client.toLowerCase()));
    if (!all.length) return text(`No AR entries found for "${client}".`);
    const paid = all.filter(r => r.status === 'Paid');
    const open = all.filter(r => r.status !== 'Paid');
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const midx = s => { const [m, y] = String(s || '').split(' '); return (parseInt(y) || 2026) * 12 + MO.indexOf(m); };
    const inv = paid.reduce((s, r) => s + (r.usdValue || r.amount || 0), 0);
    const cash = paid.reduce((s, r) => s + (r.cash || 0), 0);
    const delays = paid.filter(r => r.invoiceMonth && r.cashMonth).map(r => Math.max(0, midx(r.cashMonth) - midx(r.invoiceMonth)));
    const avgDelay = delays.length ? (delays.reduce((s, v) => s + v, 0) / delays.length).toFixed(1) : '—';
    return text([
      `## ${all[0].client} — payment history`,
      '',
      paid.length
        ? `**Collection rate:** ${inv ? ((cash / inv) * 100).toFixed(1) : '—'}% (${$(cash)} cash on ${$(inv)} invoiced, ${paid.length} paid invoices)\n**Avg delay invoice→cash:** ${avgDelay} month(s)`
        : '*No paid invoices yet.*',
      '',
      `**Open (${open.length}):**`,
      ...open.map(r => `- \`${r.id}\` ${r.invoiceMonth || '—'} → ${r.cashMonth || '—'} · ${$(r.amount || 0)} invoiced → ${$(r.cash || 0)} expected · ${r.status}`),
      '',
      `**Paid (last ${Math.min(paid.length, 8)}):**`,
      ...paid.slice(-8).map(r => `- ${r.invoiceMonth || '—'} → ${r.cashMonth || '—'} · ${$(r.cash || 0)} received`),
    ].join('\n'));
  }
);

server.tool(
  'get_contacts',
  'Contact → display-group mappings (the Contacts tab) plus any unmapped contacts appearing in GL transactions.',
  {
    type: z.enum(['client', 'vendor']).optional(),
    unmapped_only: z.boolean().optional(),
  },
  async ({ type, unmapped_only }) => {
    const { p } = await withPortal('conso');
    const d = p.get(`(function(){
      const merged=getMergedMap();
      const mapped=Object.entries(merged).map(function(e){const parts=e[0].split('||');return {contact:parts[0],entity:parts[1],group:e[1].group,type:e[1].type};});
      const seen=new Set(Object.keys(merged));
      const unmapped=[];
      E.forEach(function(m){
        [[(BH_IN_D[m]||[]).concat(BC_IN_D[m]||[]),'inflow'],[(BH_OUT_D[m]||[]).concat(BC_OUT_D[m]||[]),'outflow']].forEach(function(pair){
          pair[0].forEach(function(tx){
            const k=tx.contact+'||'+tx.entity;
            if(!seen.has(k)){seen.add(k);unmapped.push({contact:tx.contact,entity:tx.entity,direction:pair[1]});}
          });
        });
      });
      return {mapped:mapped, unmapped:unmapped};
    })()`);
    let mapped = d.mapped;
    if (type) mapped = mapped.filter(m => m.type === type);
    const lines = [];
    if (!unmapped_only) {
      lines.push(`## Mapped contacts (${mapped.length})`, '');
      mapped.forEach(m => lines.push(`- ${m.contact} (${m.entity}) → **${m.group}** [${m.type}]`));
      lines.push('');
    }
    lines.push(`## Unmapped contacts in GL (${d.unmapped.length})`, '');
    d.unmapped.forEach(u => lines.push(`- ${u.contact} (${u.entity}, ${u.direction})`));
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_comments',
  'Comment threads from the portal. Optionally filter to one cell_id or include resolved threads.',
  {
    cell_id: z.string().optional().describe("e.g. 'dash|kpi|closing-cash'"),
    include_resolved: z.boolean().optional(),
  },
  async ({ cell_id, include_resolved }) => {
    const q = cell_id
      ? `?cell_id=eq.${encodeURIComponent(cell_id)}&order=created_at.asc`
      : `?order=created_at.desc${include_resolved ? '' : '&resolved=eq.false'}`;
    const rows = await commentsRequest('GET', q);
    if (!rows.length) return text('No comments found.');
    const threads = {};
    rows.forEach(r => { (threads[r.cell_id] = threads[r.cell_id] || []).push(r); });
    const lines = [`## Comments — ${Object.keys(threads).length} thread(s)`, ''];
    for (const [cid, list] of Object.entries(threads)) {
      lines.push(`**${list[0].cell_context || cid}** (\`${cid}\`)${list.every(c => c.resolved) ? ' — resolved' : ''}`);
      list.forEach(c => lines.push(`  - ${(c.author_email || '?').split('@')[0]} (${(c.created_at || '').slice(0, 10)}): ${c.body}`));
      lines.push('');
    }
    return text(lines.join('\n'));
  }
);

// ═══════════════════════════════ ANALYSIS ════════════════════════════════════

server.tool(
  'forecast_client_cash',
  "Proposes realistic cash forecasts for a client's open invoices using their historical collection rate. Read-only — apply with update_ar_rows.",
  {
    client: z.string(),
    months: z.array(z.string()).optional().describe("Cash months to include, e.g. ['Aug 2026']"),
    override_rate: z.number().min(0).max(1.5).optional().describe('Collection rate to use instead of history'),
  },
  async ({ client, months, override_rate }) => {
    const row = await sbGet();
    const all = (row.ar_fcst || []).filter(r => (r.client || '').toLowerCase().includes(client.toLowerCase()));
    if (!all.length) return text(`No AR rows for "${client}".`);
    const paid = all.filter(r => r.status === 'Paid');
    const inv = paid.reduce((s, r) => s + (r.usdValue || r.amount || 0), 0);
    const cash = paid.reduce((s, r) => s + (r.cash || 0), 0);
    const rate = override_rate ?? (inv > 0 ? cash / inv : 1);
    let open = all.filter(r => r.status !== 'Paid');
    if (months?.length) open = open.filter(r => months.includes(r.cashMonth));
    if (!open.length) return text(`No open invoices for "${client}"${months ? ' in those months' : ''}.`);
    return text([
      `## Proposed cash forecast — ${all[0].client}`,
      `Collection rate: **${(rate * 100).toFixed(1)}%** ${override_rate !== undefined ? '(manual)' : inv > 0 ? `(from ${paid.length} paid invoices)` : '(default 100% — no history)'}`,
      '',
      '| id | Invoice month | Cash month | USD value | Current cash | Proposed cash |',
      '|---|---|---|---|---|---|',
      ...open.map(r => `| \`${r.id}\` | ${r.invoiceMonth || '—'} | ${r.cashMonth || '—'} | ${$(r.usdValue || r.amount || 0)} | ${$(r.cash || 0)} | **${$((r.usdValue || r.amount || 0) * rate)}** |`),
      '',
      'To apply: call update_ar_rows with each id and `cash` set to the proposed value (it is pinned durably via a back-solved fee, so the portal recalc keeps it).',
    ].join('\n'));
  }
);

// ═══════════════════════════════ WRITE TOOLS ═════════════════════════════════

const AR_ROW_FIELDS = {
  client: z.string(),
  entity: z.enum(['BH', 'BC']).optional().describe('Default BH'),
  amount: money.describe('Invoice amount in invoice currency'),
  currency: z.string().optional().describe('Default USD'),
  fx: money.optional().describe('FX rate to USD (default 1)'),
  fee: money.optional().describe('Payment/platform fee in USD'),
  ibPct: money.optional().describe('Interbank % (default 1)'),
  invoiceNo: z.string().optional(),
  invoiceDate: z.string().optional().describe('YYYY-MM-DD — invoiceMonth derives from this'),
  dueDate: z.string().optional(),
  paymentDate: z.string().optional().describe('YYYY-MM-DD — cashMonth auto-fills from this'),
  cashMonth: z.string().optional().describe("e.g. 'Aug 2026'; auto-filled from paymentDate if omitted"),
  status: z.enum(['Draft', 'Invoiced', 'Partial', 'Paid', 'Overdue']).optional().describe('Default Invoiced'),
  invoiceType: z.enum(['Retainer', 'One-time']).optional(),
  mode: z.string().optional().describe('Payment mode'),
  notes: z.string().optional(),
};

server.tool(
  'add_ar_rows',
  "Add AR invoice rows. USD value, interbank and expected cash are derived by the portal's own recalc (usd = amount×fx; cash = usd − fee − interbank), like the Add Invoice modal. A row with no cashMonth and no paymentDate won't appear in any forecast month.",
  { rows: z.array(z.object(AR_ROW_FIELDS)).min(1) },
  async ({ rows }) => {
    const { p } = await withPortal();
    const added = p.get(`(function(rows){
      const out=[];
      rows.forEach(function(r,_i){
        r.id=${NEW_ID};
        if(!r.status)r.status='Draft';
        if(!r.entity)r.entity='BH';
        if(!r.currency)r.currency='USD';
        if(!r.cashMonth&&r.paymentDate){const d=new Date(r.paymentDate);if(!isNaN(d))r.cashMonth=ALL_MONTHS[d.getMonth()]+' '+d.getFullYear();}
        recalcARRow(r);
        AR_FCST.push(r); out.push(r);
      });
      recomputeFcstMonths();
      return out;
    })(${JSON.stringify(rows)})`);
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST') });
    const warn = added.filter(r => !r.cashMonth).map(r => `⚠ ${r.client}: no cashMonth/paymentDate — will not show in any forecast month.`);
    return text(note + ['## Added ' + added.length + ' AR row(s)', '', ...added.map(r => `- \`${r.id}\` ${r.client} (${r.entity}) ${r.status} · inv ${r.invoiceMonth || '—'} → cash ${r.cashMonth || '—'} · ${$(r.amount)} → cash ${$(r.cash)}`), ...(warn.length ? ['', ...warn] : [])].join('\n'));
  }
);

server.tool(
  'update_ar_rows',
  'Update AR rows by id (get ids from get_ar). Any provided field is changed, then the portal recalc re-derives usdValue/interbank/cash/months. Pass cash to pin expected cash to a specific number — this is implemented by back-solving the fee so it survives the portal recalc that runs on every load (cash is a derived field the portal never stores raw).',
  {
    updates: z.array(z.object({
      id: z.string().describe('Row id from get_ar'),
      client: z.string().optional(),
      entity: z.enum(['BH', 'BC']).optional(),
      amount: money.optional(),
      currency: z.string().optional(),
      fx: money.optional(),
      fee: money.optional(),
      ibPct: money.optional(),
      invoiceNo: z.string().optional(),
      invoiceDate: z.string().optional(),
      dueDate: z.string().optional(),
      paymentDate: z.string().optional(),
      cashMonth: z.string().optional(),
      status: z.enum(['Draft', 'Invoiced', 'Partial', 'Paid', 'Overdue']).optional(),
      invoiceType: z.enum(['Retainer', 'One-time']).optional(),
      mode: z.string().optional(),
      notes: z.string().optional(),
      cash: money.optional().describe('Pin expected cash to this USD amount (durably, via a back-solved fee)'),
    })).min(1),
  },
  async ({ updates }) => {
    const { p } = await withPortal();
    const log = p.get(`(function(ups){
      const log=[];
      ups.forEach(function(u){
        const i=AR_FCST.findIndex(function(r){return String(r.id)===String(u.id);});
        if(i<0){log.push('NOT FOUND: '+u.id);return;}
        const setCash=u.cash;
        Object.keys(u).forEach(function(k){ if(k!=='id'&&k!=='cash'&&u[k]!==undefined)AR_FCST[i][k]=u[k]; });
        recalcARRow(AR_FCST[i]);
        if(setCash!==undefined){
          // cash = usdValue - fee - interbank, and recalcARRow re-derives it on every load.
          // Back-solve fee so a future recalc reproduces exactly this cash.
          var r=AR_FCST[i];
          r.fee=Math.round((r.usdValue - r.interbank - setCash)*100)/100;
          recalcARRow(r);
        }
        log.push(AR_FCST[i].client+' ('+u.id+'): cash '+AR_FCST[i].cash+', cashMonth '+AR_FCST[i].cashMonth+', status '+AR_FCST[i].status);
      });
      recomputeFcstMonths();
      return log;
    })(${JSON.stringify(updates)})`);
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST') });
    return text(note + ['## AR updates', '', ...log.map(l => '- ' + l)].join('\n'));
  }
);

server.tool(
  'delete_ar_rows',
  'Delete AR rows by id. Get ids from get_ar first. This cannot be undone.',
  { ids: z.array(z.string()).min(1) },
  async ({ ids }) => {
    const { p } = await withPortal();
    const removed = p.get(`(function(ids){
      const before=AR_FCST.length;
      const gone=AR_FCST.filter(function(r){return ids.indexOf(String(r.id))>=0;}).map(function(r){return r.client+' '+(r.invoiceMonth||'')+' '+(r.cash||r.amount||0);});
      AR_FCST=AR_FCST.filter(function(r){return ids.indexOf(String(r.id))<0;});
      recomputeFcstMonths();
      return {gone:gone, removed:before-AR_FCST.length};
    })(${JSON.stringify(ids.map(String))})`);
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST') });
    return text(note + `Deleted ${removed.removed} AR row(s):\n${removed.gone.map(g => '- ' + g).join('\n')}`);
  }
);

const AP_ROW_FIELDS = {
  vendor: z.string(),
  entity: z.enum(['BH', 'BC']).optional(),
  amount: money.describe('USD amount'),
  workMonth: z.string().optional().describe("Month the work relates to, e.g. 'Jul 2026'"),
  paymentDate: z.string().optional().describe('YYYY-MM-DD — cashMonth auto-fills from this'),
  cashMonth: z.string().optional(),
  spendType: z.string().optional().describe('Variable or Fixed (any casing — portal normalizes)'),
  expenseCategory: z.string().optional().describe('COS, OPEX or TAX (any casing — portal normalizes)'),
  paymentMode: z.string().optional().describe('Skuad / Bank Transfer / Alaan Pay / other'),
  notes: z.string().optional(),
};

server.tool(
  'add_ap_rows',
  'Add AP payment rows (like the Add Payment modal). cashMonth auto-fills from paymentDate; spendType/category/paymentMode casing is normalized by the portal recalc.',
  { rows: z.array(z.object(AP_ROW_FIELDS)).min(1) },
  async ({ rows }) => {
    const { p } = await withPortal();
    const added = p.get(`(function(rows){
      const out=[];
      rows.forEach(function(r,_i){
        r.id=${NEW_ID};
        if(!r.entity)r.entity='BH';
        recalcAPRow(r);
        AP_FCST.push(r); out.push(r);
      });
      recomputeFcstMonths();
      return out;
    })(${JSON.stringify(rows)})`);
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST') });
    return text(note + ['## Added ' + added.length + ' AP row(s)', '', ...added.map(r => `- \`${r.id}\` ${r.vendor} (${r.entity}) · cash ${r.cashMonth || '—'} · ${$(r.amount)} · ${r.spendType || '—'}/${r.expenseCategory || '—'}`)].join('\n'));
  }
);

server.tool(
  'update_ap_rows',
  'Update AP rows by id (from get_ap). Provided fields change, then portal recalc normalizes.',
  {
    updates: z.array(z.object({
      id: z.string(),
      vendor: z.string().optional(),
      entity: z.enum(['BH', 'BC']).optional(),
      amount: money.optional(),
      workMonth: z.string().optional(),
      paymentDate: z.string().optional(),
      cashMonth: z.string().optional(),
      spendType: z.string().optional(),
      expenseCategory: z.string().optional(),
      paymentMode: z.string().optional(),
      notes: z.string().optional(),
    })).min(1),
  },
  async ({ updates }) => {
    const { p } = await withPortal();
    const log = p.get(`(function(ups){
      const log=[];
      ups.forEach(function(u){
        const i=AP_FCST.findIndex(function(r){return String(r.id)===String(u.id);});
        if(i<0){log.push('NOT FOUND: '+u.id);return;}
        Object.keys(u).forEach(function(k){ if(k!=='id'&&u[k]!==undefined)AP_FCST[i][k]=u[k]; });
        recalcAPRow(AP_FCST[i]);
        log.push(AP_FCST[i].vendor+' ('+u.id+'): '+AP_FCST[i].amount+' in '+(AP_FCST[i].cashMonth||'—'));
      });
      recomputeFcstMonths();
      return log;
    })(${JSON.stringify(updates)})`);
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST') });
    return text(note + ['## AP updates', '', ...log.map(l => '- ' + l)].join('\n'));
  }
);

server.tool(
  'delete_ap_rows',
  'Delete AP rows by id. Get ids from get_ap first. This cannot be undone.',
  { ids: z.array(z.string()).min(1) },
  async ({ ids }) => {
    const { p } = await withPortal();
    const removed = p.get(`(function(ids){
      const before=AP_FCST.length;
      const gone=AP_FCST.filter(function(r){return ids.indexOf(String(r.id))>=0;}).map(function(r){return r.vendor+' '+(r.cashMonth||'')+' '+(r.amount||0);});
      AP_FCST=AP_FCST.filter(function(r){return ids.indexOf(String(r.id))<0;});
      recomputeFcstMonths();
      return {gone:gone, removed:before-AP_FCST.length};
    })(${JSON.stringify(ids.map(String))})`);
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST') });
    return text(note + `Deleted ${removed.removed} AP row(s):\n${removed.gone.map(g => '- ' + g).join('\n')}`);
  }
);

server.tool(
  'set_contact_mapping',
  'Map contacts to display groups (the Contacts tab). Grouping changes how the CF statement clusters transactions. Set remove=true to unmap.',
  {
    mappings: z.array(z.object({
      contact: z.string().describe('Exact contact name as in GL/AR/AP'),
      entity: z.enum(['BH', 'BC']),
      group: z.string().optional().describe('Display group name'),
      type: z.enum(['client', 'vendor']).optional(),
      remove: z.boolean().optional(),
    })).min(1),
  },
  async ({ mappings }) => {
    const { p } = await withPortal();
    const log = p.get(`(function(ms){
      const log=[];
      ms.forEach(function(m){
        const k=m.contact+'||'+m.entity;
        if(m.remove){ delete CT_MAP[k]; log.push('unmapped '+k); return; }
        CT_MAP[k]={group:m.group||m.contact, type:m.type||'client'};
        log.push(k+' -> '+CT_MAP[k].group+' ['+CT_MAP[k].type+']');
      });
      return log;
    })(${JSON.stringify(mappings)})`);
    const note = await sbPatch({ ct_map: p.get('CT_MAP') });
    return text(note + ['## Contact mappings', '', ...log.map(l => '- ' + l)].join('\n'));
  }
);

server.tool(
  'set_gl_mapping',
  'Add or remove Xero account → dashboard template row mappings (Contacts tab → GL Accounts). Controls how imported Xero lines land on the Financials tab.',
  {
    entity: z.enum(['bh', 'bc']),
    statement: z.enum(['pl', 'bs']),
    add: z.array(z.object({ xero: z.string(), tmpl: z.string() })).optional(),
    remove: z.array(z.string()).optional().describe('Xero labels to unmap'),
  },
  async ({ entity, statement, add, remove }) => {
    const { row, p } = await withPortal();
    const key = `${entity}_${statement}`;
    const log = p.get(`(function(key,add,remove){
      GL_MAPPINGS[key]=GL_MAPPINGS[key]||[];
      const log=[];
      (remove||[]).forEach(function(x){
        const n=GL_MAPPINGS[key].length;
        GL_MAPPINGS[key]=GL_MAPPINGS[key].filter(function(m){return m.xero!==x;});
        log.push((n>GL_MAPPINGS[key].length?'removed ':'not found: ')+x);
      });
      (add||[]).forEach(function(m){
        GL_MAPPINGS[key]=GL_MAPPINGS[key].filter(function(e){return e.xero!==m.xero;});
        GL_MAPPINGS[key].push({xero:m.xero,tmpl:m.tmpl});
        log.push('mapped '+m.xero+' -> '+m.tmpl);
      });
      saveActuals();
      return log;
    })(${JSON.stringify(key)}, ${JSON.stringify(add || [])}, ${JSON.stringify(remove || [])})`);
    const chk = mergedActualsSnap(row, p);
    const note = await sbPatch({ gl_mappings: p.get('GL_MAPPINGS'), actuals_snap: chk.snap });
    return text(note + ['## GL mappings (' + key + ')', '', ...log.map(l => '- ' + l), ...(chk.missing.length ? [`\n(note: preserved cloud actuals not re-parsed this session: ${chk.missing.join(', ')})`] : [])].join('\n'));
  }
);

server.tool(
  'manage_dashboard_rows',
  'Add or delete a custom row on the Financials P&L/BS template (Contacts tab → GL Accounts → Add new dashboard row).',
  {
    action: z.enum(['add', 'delete']),
    entity: z.enum(['bh', 'bc']),
    statement: z.enum(['pl', 'bs']),
    section: z.string().describe('Section header the row lives under'),
    label: z.string().describe('Row label'),
    xero: z.string().optional().describe('Optional Xero account to map onto the new row'),
  },
  async ({ action, entity, statement, section, label, xero }) => {
    const { row, p } = await withPortal();
    const msg = p.get(`(function(a){
      const key=a.entity+'_'+a.statement;
      if(a.action==='add'){
        if(USER_ROWS.find(function(r){return r.entity===a.entity&&r.ftype===a.statement&&r.label===a.label;}))return 'Row already exists';
        USER_ROWS.push({entity:a.entity,ftype:a.statement,section:a.section,label:a.label,xero:a.xero||''});
        applyUserRows();
        if(a.xero){GL_MAPPINGS[key]=GL_MAPPINGS[key]||[];GL_MAPPINGS[key]=GL_MAPPINGS[key].filter(function(e){return e.xero!==a.xero;});GL_MAPPINGS[key].push({xero:a.xero,tmpl:a.label});}
        saveActuals();
        return 'Added row "'+a.label+'" under '+a.section+(a.xero?' mapped from '+a.xero:'');
      }
      const n=USER_ROWS.length;
      USER_ROWS=USER_ROWS.filter(function(r){return !(r.entity===a.entity&&r.ftype===a.statement&&r.label===a.label);});
      saveActuals();
      return n>USER_ROWS.length?'Deleted row "'+a.label+'"':'Row not found';
    })(${JSON.stringify({ action, entity, statement, section, label, xero })})`);
    const chk = mergedActualsSnap(row, p);
    const note = await sbPatch({ gl_mappings: p.get('GL_MAPPINGS'), actuals_snap: chk.snap });
    return text(note + msg + (chk.missing.length ? `\n(note: preserved cloud actuals not re-parsed this session: ${chk.missing.join(', ')})` : ''));
  }
);

server.tool(
  'set_cf_override',
  "Per-transaction CF Working overrides: reassign a transaction's display group, net an outflow against a client inflow (fee netting), or clear overrides. Get tx_key from get_cf_transactions. NOTE: unlike the portal (where these only sync piggybacked on other saves), this writes to the cloud immediately.",
  {
    tx_key: z.string().describe("From get_cf_transactions, format 'date||contact||entity||account'"),
    display_group: z.string().optional().describe('Reassign this tx to a display group'),
    net_against: z.string().optional().describe('Outflows only: inflow contact name to net this against'),
    clear: z.boolean().optional().describe('Clear both overrides for this tx'),
  },
  async ({ tx_key, display_group, net_against, clear }) => {
    // Real tx_keys are 'date||contact||entity||account'. Reject malformed keys (e.g. '__proto__',
    // which would hit Object.prototype's setter and silently store nothing while reporting success).
    if (!tx_key.includes('||')) return text("Invalid tx_key — expected 'date||contact||entity||account' from get_cf_transactions.");
    const { p } = await withPortal();
    const msg = p.get(`(function(k,dg,na,clr){
      const log=[];
      if(clr){ delete CF_TX_OVERRIDES[k]; delete CF_NET_OVERRIDES[k]; log.push('cleared overrides for '+k); }
      if(dg){ CF_TX_OVERRIDES[k]=dg; log.push('display group -> '+dg); }
      if(na){ CF_NET_OVERRIDES[k]=na; log.push('netted against '+na); }
      return log;
    })(${JSON.stringify(tx_key)}, ${JSON.stringify(display_group || null)}, ${JSON.stringify(net_against || null)}, ${JSON.stringify(!!clear)})`);
    if (!msg.length) return text('Nothing to do — pass display_group, net_against, or clear.');
    const note = await sbPatch({ cf_tx_overrides: p.get('CF_TX_OVERRIDES'), cf_net_overrides: p.get('CF_NET_OVERRIDES') });
    return text(note + msg.map(l => '- ' + l).join('\n'));
  }
);

server.tool(
  'import_xero_data',
  "Import a Xero export (GL account transactions, Balance Sheet, or P&L) — same as dropping the file on the portal's Import tab. Pass the sheet as raw rows: an array of arrays exactly as the sheet reads row by row (header rows included, dates as strings like '12 Jan 2026'). The portal's own parser processes it.",
  {
    entity: z.enum(['bh', 'bc']),
    ftype: z.enum(['gl', 'bs', 'pl']).describe('gl = account transactions, bs = balance sheet, pl = profit & loss'),
    raw_rows: z.array(z.array(z.any())).min(2).describe('Sheet contents, array of row arrays, header rows included'),
  },
  async ({ entity, ftype, raw_rows }) => {
    const { row, p } = await withPortal();
    const summary = p.get(`(function(rows,e,ft){
      const parsed = ft==='gl' ? parseXeroAccountTx(rows, e.toUpperCase()) : _parseFinancialReport(rows, e.toUpperCase(), ft);
      if(!parsed || !parsed.months || !parsed.months.length) return {error:'Parser produced no months — check the rows format'};
      importState[e+'-'+ft]=parsed;
      applyImport(e,ft);
      saveActuals();
      const sum={months:parsed.months};
      if(ft==='gl'){
        sum.inflowTx=Object.values(parsed.inflow||{}).reduce(function(s,a){return s+a.length;},0);
        sum.outflowTx=Object.values(parsed.outflow||{}).reduce(function(s,a){return s+a.length;},0);
        sum.banks=Object.keys(parsed.bankClose||{});
      } else {
        sum.rows=(parsed.rows||[]).length;
      }
      return sum;
    })(${JSON.stringify(raw_rows)}, ${JSON.stringify(entity)}, ${JSON.stringify(ftype)})`);
    if (summary.error) return text(`⚠ Import failed: ${summary.error}`);
    const note = await sbPatch({ actuals_snap: mergedActualsSnap(row, p).snap });
    return text(note + [
      `## Imported ${entity.toUpperCase()} ${ftype.toUpperCase()}`,
      `Months: ${summary.months.join(', ')}`,
      summary.inflowTx !== undefined ? `Inflow txs: ${summary.inflowTx} · Outflow txs: ${summary.outflowTx} · Bank accounts: ${summary.banks.join(', ')}` : `Statement rows: ${summary.rows}`,
      '',
      'The portal will pick this up on next load / Pull latest.',
    ].join('\n'));
  }
);

server.tool(
  'add_comment',
  'Post a comment on a portal metric (appears in the Comments panel for all users).',
  {
    cell_id: z.string().describe("e.g. 'dash|kpi|closing-cash', 'cf|main|total-inflow', 'fin|<table>|<row>'"),
    cell_context: z.string().describe("Human label, e.g. 'Dashboard · Closing cash balance'"),
    body: z.string(),
    author_email: z.string().optional().describe('Defaults to claude@indexed'),
  },
  async ({ cell_id, cell_context, body, author_email }) => {
    if (DRY_RUN) return text('[DRY RUN] comment not posted');
    await commentsRequest('POST', '', { cell_id, cell_context, body, author_email: author_email || 'claude@indexed', resolved: false });
    return text(`✓ Comment posted on "${cell_context}".`);
  }
);

server.tool(
  'resolve_comment',
  'Resolve or reopen a whole comment thread by cell_id.',
  {
    cell_id: z.string(),
    reopen: z.boolean().optional().describe('true = reopen instead of resolve'),
  },
  async ({ cell_id, reopen }) => {
    if (DRY_RUN) return text('[DRY RUN] thread not changed');
    await commentsRequest('PATCH', `?cell_id=eq.${encodeURIComponent(cell_id)}`,
      reopen ? { resolved: false, resolved_by: null, resolved_at: null }
             : { resolved: true, resolved_by: 'claude-mcp', resolved_at: new Date().toISOString() });
    return text(`✓ Thread ${reopen ? 'reopened' : 'resolved'}: ${cell_id}`);
  }
);

return server;
}

// ── HTTP transport ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '20mb' }));

// Auth gate. MCP_AUTH_TOKEN holds a comma-separated list of allowed tokens, each optionally
// "label:token" (e.g. "karan:abc123,anjan:def456"). Any match authorizes; revoke one person by
// deleting their entry. If unset, /mcp is open (local dev only). /health always stays open.
const AUTH_TOKENS = (process.env.MCP_AUTH_TOKEN || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const i = s.indexOf(':'); return i > 0 ? { label: s.slice(0, i), token: s.slice(i + 1) } : { label: 'token', token: s }; });

function tokenMatch(provided) {
  const a = Buffer.from(provided);
  for (const t of AUTH_TOKENS) {
    const b = Buffer.from(t.token);
    if (a.length === b.length && timingSafeEqual(a, b)) return t.label;
  }
  return null;
}

app.use('/mcp', (req, res, next) => {
  if (!AUTH_TOKENS.length) return next();
  const hdr = req.headers['authorization'] || '';
  const provided = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.token || '');
  const who = provided && tokenMatch(provided);
  if (!who) { res.status(401).json({ error: 'Unauthorized — missing or invalid token' }); return; }
  req.mcpUser = who;
  next();
});

const transports = {};

app.post('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  let transport = sid && transports[sid];
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { transports[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (!sid || !transports[sid]) { res.status(400).json({ error: 'Invalid or missing session ID' }); return; }
  await transports[sid].handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (sid && transports[sid]) { await transports[sid].close(); delete transports[sid]; }
  res.status(204).end();
});

app.get('/health', async (_, res) => {
  try {
    const { p } = await withPortal('conso');
    res.json({ status: 'ok', server: 'indexed-fpa-mcp v2', actualMonths: p.get('E'), dryRun: DRY_RUN });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

process.on('unhandledRejection', e => console.warn('unhandledRejection (ignored):', e?.message || e));

app.listen(PORT, () => console.log(`Indexed FP&A MCP v2 on port ${PORT}${DRY_RUN ? ' [DRY RUN]' : ''}`));
