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

// Patches ONLY the given columns — never the whole state — so a concurrent portal session editing a different
// column is never clobbered. Conditional on the row being unchanged since this request read it (p.readAt), so a
// save made meanwhile (a portal tab, another request) is never overwritten with this request's older copy.
async function sbPatch(cols, p) {
  const payload = { ...cols, updated_at: new Date().toISOString(), updated_by: 'claude-mcp' };
  if (DRY_RUN) {
    console.log('[DRY RUN] PATCH forecast_data:', Object.keys(cols).join(', '));
    return '[DRY RUN — no data written] ';
  }
  const { url } = await ensureSB();
  const pre = p && 'readAt' in p ? (p.readAt ? `&updated_at=eq.${encodeURIComponent(p.readAt)}` : '&updated_at=is.null') : '';
  const res = await fetch(`${url}/rest/v1/forecast_data?id=eq.1${pre}&select=id`, {
    method: 'PATCH',
    headers: { ...(await sbHeaders()), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${await res.text()}`);
  const rows = await res.json().catch(() => []);
  if (pre && (!Array.isArray(rows) || !rows.length)) {
    throw new Error('Not saved: the portal data changed while this request was running (someone saved at the same moment). Nothing was written — run the same request again.');
  }
  if (p) p.readAt = payload.updated_at;
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

// Strict month check + sanity warnings via the portal's own strictMonth/rowWarnings (older portals: no check).
// Throws, writing nothing, if any month value is ambiguous ('Jan-27', bare 'Jun', '01/27').
function checkRowMonths(p, rows, keys, label) {
  if (!p.get(`typeof strictMonth==='function'`)) return rows;
  const bad = [];
  rows.forEach((r, i) => keys.forEach(k => {
    if (r[k] === undefined || r[k] === '') return;
    const v = p.get(`strictMonth(${JSON.stringify(r[k])})`);
    if (v === null) bad.push(`${label(r, i)}: ${k} "${r[k]}"`); else r[k] = v;
  }));
  if (bad.length) throw new Error(`Nothing written — month values must be 'Mon YYYY', 'Month YYYY' or an ISO date (ambiguous forms like 'Jan-27' are rejected):\n${bad.join('\n')}`);
  return rows;
}
function rowWarnLines(p, side, rows, label) {
  if (!p.get(`typeof rowWarnings==='function'`)) return [];
  return rows.flatMap((r, i) => p.get(`rowWarnings(${JSON.stringify(side)}, ${JSON.stringify(r)})`).map(w => `⚠ ${label(r, i)}: ${w}`));
}

// ── Headless portal session ──────────────────────────────────────────────────

async function withPortal(entity = 'conso') {
  const row = await sbGet();
  const p = await hydrate(row);
  p.setEntity(entity);
  p.readAt = row.updated_at || null; // writes are conditional on this (see sbPatch)
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
  'All dashboard KPIs exactly as the portal computes them for its reporting year (the year of the latest actual month): closing cash, AR, YTD inflow/outflow/net, founder payments, Founder Cash Earnings, Dec closing forecast, revenue/GP/adj-net P&L metrics, full-year revenue (YTD + forecast to Dec), and liabilities.',
  { entity: ENTITY },
  async ({ entity }) => {
    const { p } = await withPortal(entity || 'conso');
    const m = p.get(`(function(){
      const d=getD();
      // Same reporting year and helpers as the portal's renderDash (older portals: all of E is 2026).
      const yr=typeof dashYear==='function'?dashYear():Number(FCST_YEAR);
      const yIdx=typeof reportIdx==='function'?reportIdx(yr):typeof yearIdx==='function'?yearIdx(yr):E.map(function(_,i){return i;});
      const full=function(m){return typeof mFull==='function'?mFull(m):(/\d{4}/.test(m)?m:m+' '+FCST_YEAR);};
      const ytdIn=yIdx.reduce(function(s,i){return s+d.in[i];},0), ytdOut=yIdx.reduce(function(s,i){return s+d.out[i];},0);
      const founderPmt=getFounderPayments();
      const decClose=getDecClosingBalance();
      const openYr=typeof getYearOpening==='function'?getYearOpening(yr):d.open;
      const pl=getPL(), bs=getBSMetrics();
      const fcstYr=(typeof cfForecastMonths==='function'?cfForecastMonths():FCST_MONTHS).filter(function(x){return full(x).slice(-4)===String(yr);});
      const fcstRevTotal=fcstYr.reduce(function(s,x){return s+getFcastInflow(x);},0);
      const rng=function(x,y){return typeof mRange==='function'?mRange(x,y):full(x)+'–'+full(y);};
      return { year:yr, actualMonths:E.map(full), actRange:rng(E[0],E[E.length-1]), ytdRange:rng(E[yIdx[0]||0],E[E.length-1]),
        fcstRange:FCST_MONTHS.length?rng(FCST_MONTHS[0],FCST_MONTHS[FCST_MONTHS.length-1]):'—', openingJan:openYr,
        closingCash:d.close[d.close.length-1], monthlyClosing:d.close, ar:bs.ar,
        ytdInflow:ytdIn, ytdOutflow:ytdOut, netMovement:ytdIn-ytdOut,
        founderPayments:founderPmt, adjNetMovement:ytdIn-ytdOut+founderPmt,
        decClosingForecast:decClose, founderCashEarnings:decClose-openYr+founderPmt,
        pl:pl, liabilities:{accountsPayable:bs.ap, accruals:bs.accruals, directorsLoanAcct:bs.dirLoan, loanFromDirector:bs.loanDir},
        fullYearRev:pl.ytdRev+fcstRevTotal };
    })()`);
    const lines = [
      `## Dashboard — ${(entity || 'conso').toUpperCase()}`,
      `Actuals: ${m.actRange} · Forecast: ${m.fcstRange} · YTD = ${m.ytdRange}`,
      '',
      `**Closing cash balance:** ${$(m.closingCash)} (${m.actualMonths[m.actualMonths.length - 1]})`,
      `**Accounts receivable:** ${$(m.ar)}`,
      `**YTD inflow:** ${$(m.ytdInflow)} · **YTD outflow:** ${$(m.ytdOutflow)} · **Net:** ${$(m.netMovement)}`,
      `**Founder payments (Jan–Dec ${m.year}):** ${$(m.founderPayments)}`,
      `**Founder cash earnings:** ${$(m.founderCashEarnings)} (Dec ${m.year} close ${$(m.decClosingForecast)} − Jan ${m.year} open ${$(m.openingJan)} + founder payments)`,
      '',
      `**${m.year} revenue (YTD + forecast to Dec):** ${$(m.fullYearRev)}`,
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
      if(typeof cfColumns==='function'){
        // The portal's own statement: exactly the columns and last column the CF tab renders (unfiltered).
        cfMonthSel=null; renderCF();
        const v=_cfView;
        const late=typeof closedPipelineRows==='function'?closedPipelineRows():[];
        return {mode:cfMode, closedThrough:typeof booksClosedOrd==='function'?mFromOrd(booksClosedOrd()):null, closedSet:typeof getSetting==='function'&&!!getSetting('booksClosedThrough'), late:late.length,
          ytdLabel:v.tot.label, ytdIn:v.tot.in, ytdOut:v.tot.out, rows:v.cols.map(function(c){
          return {month:mFull(c.full),type:c.kind==='A'?'actual':c.held?'progress':'forecast',opening:c.open,inflow:c.in,outflow:c.out,net:c.in-c.out,fx:c.fx||0,closing:c.close};})};
      }
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
      return {mode:cfMode,ytdLabel:'YTD actuals',rows:rows,ytdIn:actIn.reduce(function(s,v){return s+v;},0),ytdOut:actOut.reduce(function(s,v){return s+v;},0)};
    })()`);
    const lines = [
      `## Cash flow statement — ${(entity || 'conso').toUpperCase()} (${s.mode})`,
      '',
      '| Month | | Opening | Inflow | Outflow | Net | Closing |',
      '|---|---|---|---|---|---|---|',
      ...s.rows.map(r => `| ${r.month} | ${r.type === 'actual' ? 'A' : r.type === 'progress' ? 'F*' : 'F'} | ${$(r.opening)} | ${$(r.inflow)} | ${$(r.outflow)} | ${$(r.net)} | **${$(r.closing)}** |`),
      '',
      `${s.ytdLabel}: inflow ${$(s.ytdIn)}, outflow ${$(s.ytdOut)}, net ${$(s.ytdIn - s.ytdOut)}`,
    ];
    if (s.closedThrough) lines.splice(1, 0, `Books closed through ${s.closedThrough}${s.closedSet ? '' : ' (auto: the month before this one)'} — months up to it are GL actuals; the forecast opens from its closing.`);
    if (s.rows.some(r => r.type === 'progress')) lines.push('', 'F* = after the books-closed month but already partly imported — forecast from the AR/AP pipeline, not the partial GL.');
    if (s.late) lines.push('', `⚠ ${s.late} pipeline row(s) fall in closed months and are not in the forecast — see get_settings.`);
    return text(lines.join('\n'));
  }
);

server.tool(
  'get_cf_groups',
  'Cash flow broken down by display group (the drill-down level of the CF statement): per-month amounts per client/vendor group, split into actual and forecast months exactly as the portal CF table does (finished months are actuals; a month still in progress is the first forecast month).',
  {
    entity: ENTITY,
    direction: z.enum(['inflow', 'outflow']).describe('Which side of the cash flow'),
    mode: z.enum(['hybrid', 'actuals']).optional().describe("'hybrid' (default): actuals then forecast months; 'actuals' shows all GL actual months only."),
    include_forecast: z.boolean().optional().describe('Include forecast months from the AR/AP pipeline (default true)'),
  },
  async ({ entity, direction, mode, include_forecast }) => {
    const { p } = await withPortal(entity || 'conso');
    const isIn = direction === 'inflow';
    const E = p.get('E');
    const FCST = p.get('FCST_MONTHS');
    const FY = p.get('FCST_YEAR');
    // The portal's own split (finished months are actuals; a month still in progress is the first forecast
    // column) and its drill-down groups, read after rendering the CF tab in the requested mode.
    const view = p.get(`(function(){
      if(typeof cfColumns!=='function')return null;
      cfMode=${JSON.stringify(mode === 'actuals' ? 'actuals' : 'hybrid')}; cfMonthSel=null; renderCF();
      return {act:_cfView.cols.filter(function(c){return c.kind==='A';}).map(function(c){return c.key;}),
        fcst:_cfView.cols.filter(function(c){return c.kind==='F';}).map(function(c){return c.full;}),
        actG:${isIn ? '_cfInGroups' : '_cfOutGroups'}, fcG:${isIn ? '_cfInFcstGroups' : '_cfOutFcstGroups'}};
    })()`);
    const hybrid = mode !== 'actuals' && E.length > 1;
    const actMonths = view ? view.act : (hybrid ? E.slice(0, -1) : E.slice());
    const fcstMonths = include_forecast === false ? [] : view ? view.fcst : (hybrid ? [`${E[E.length - 1]} ${FY}`, ...FCST] : FCST);
    const act = view ? view.actG : p.get(`buildCFGroups(${isIn})`);
    const fcst = !fcstMonths.length ? [] : view ? view.fcG : p.get(`buildFcastCFGroups(${isIn}, ${JSON.stringify(fcstMonths)})`);
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
  'replace_forecast',
  "Plan sync, in one atomic save: on one side (AR or AP) delete every row tagged source='plan' and insert the given rows as the new plan rows (tagged 'plan'). Manual rows (e.g. open AR invoices, anything added by hand) and rows in closed months (up to 'books closed through') are never touched; new rows dated in a closed month are skipped and reported. Months must be 'Mon YYYY', 'Month YYYY' or ISO dates — any ambiguous value rejects the whole call (nothing written). Row ids are derived from content, so running it twice with the same input leaves identical data. Returns totals by month and entity before and after.",
  {
    side: z.enum(['ar', 'ap']),
    rows: z.array(z.object({}).passthrough()).describe('AR rows: same fields as add_ar_rows; AP rows: same fields as add_ap_rows'),
    replace_untagged: z.boolean().optional().describe("First sync only: also treat untagged rows (synced before source tags existed) in open months as plan rows — on AR only Draft ones (Invoiced/Partial/Overdue/Paid invoices are always kept). Default false — untagged rows count as manual."),
  },
  async ({ side, rows, replace_untagged }) => {
    const { p } = await withPortal();
    if (!p.get(`typeof strictMonth==='function'&&typeof booksClosedOrd==='function'`)) throw new Error('This portal version does not support replace_forecast yet.');
    const AR = side === 'ar';
    checkRowMonths(p, rows, AR ? ['cashMonth', 'invoiceMonth'] : ['cashMonth', 'workMonth'], (r, i) => `row ${i + 1} (${(AR ? r.client : r.vendor) || '?'})`);
    const res = p.get(`(function(side,rows,untagged){
      const AR=side==='ar', arr=AR?AR_FCST:AP_FCST, closed=booksClosedOrd();
      const cm=function(r){return mOrd(normalizeCashMonth(r.cashMonth));};
      const inClosed=function(r){const o=cm(r);return !isNaN(o)&&o<=closed;};
      // untagged rows only with replace_untagged — and on AR only Draft ones: booked invoices are never plan rows
      const isPlan=function(r){return r.source==='plan'||(untagged&&!r.source&&(!AR||r.status==='Draft'));};
      const errors=[], skipped=[], fresh=[], seen={};
      rows.forEach(function(r,i){
        const name=AR?r.client:r.vendor;
        if(!name){errors.push('row '+(i+1)+': '+(AR?'client':'vendor')+' is required');return;}
        if(!r.entity)r.entity='BH';
        if(AR){if(!r.currency)r.currency='USD';if(!r.status)r.status='Draft';}
        if(!r.cashMonth&&r.paymentDate){const m=/^(\\d{4})-(\\d{2})/.exec(String(r.paymentDate));if(m)r.cashMonth=ALL_MONTHS[+m[2]-1]+' '+m[1];}
        if(!r.cashMonth){errors.push('row '+(i+1)+' ('+name+'): needs cashMonth or paymentDate');return;}
        r.source='plan';
        if(AR)recalcARRow(r);else recalcAPRow(r);
        if(inClosed(r)){skipped.push(name+' · '+r.cashMonth);return;}
        const base=[side,r.entity,name,normalizeCashMonth(r.cashMonth),AR?(r.amount||0):(r.amount||0),AR?(r.invoiceMonth||''):(r.workMonth||'')].join('|');
        seen[base]=(seen[base]||0)+1;
        r.id='plan-'+side+'-'+dsVersion(base+'#'+seen[base]).replace(/\\./g,'');
        fresh.push(r);
      });
      if(errors.length)return {errors:errors};
      const totals=function(list){const t={};list.forEach(function(r){const k=(normalizeCashMonth(r.cashMonth)||'(none)')+'|'+(r.entity||'BH').toUpperCase();t[k]=(t[k]||0)+(AR?(r.cash||0):(r.amount||0));});return t;};
      const before=totals(arr);
      const drop=function(r){return isPlan(r)&&!inClosed(r);};
      const removed=arr.filter(drop).length, kept=arr.filter(function(r){return !drop(r);});
      const next=kept.concat(fresh);
      const tk='__tomb__||'+side+'_fcst'; // the sheet is the source of truth for plan rows: re-inserted ids are not deleted rows
      if(CT_MAP[tk]&&CT_MAP[tk].ids)fresh.forEach(function(r){delete CT_MAP[tk].ids[String(r.id)];});
      if(AR)AR_FCST=next;else AP_FCST=next;
      recomputeFcstMonths();
      return {removed:removed, inserted:fresh.length, kept:kept.length, skipped:skipped, before:before, after:totals(next)};
    })(${JSON.stringify(side)}, ${JSON.stringify(rows)}, ${!!replace_untagged})`);
    if (res.errors) throw new Error(`Nothing written — fix these rows:\n${res.errors.join('\n')}`);
    const note = await sbPatch({ [AR ? 'ar_fcst' : 'ap_fcst']: p.get(AR ? 'AR_FCST' : 'AP_FCST'), ct_map: p.get('CT_MAP') }, p);
    const keys = [...new Set([...Object.keys(res.before), ...Object.keys(res.after)])]
      .sort((a, b) => p.get(`mOrd(${JSON.stringify(a.split('|')[0])})`) - p.get(`mOrd(${JSON.stringify(b.split('|')[0])})`) || a.localeCompare(b));
    const tbl = keys.map(k => { const [m, e] = k.split('|'), b = res.before[k] || 0, a = res.after[k] || 0;
      return `| ${m} | ${e} | ${$(b)} | ${$(a)} | ${Math.abs(a - b) < 0.005 ? '—' : (a > b ? '+' : '') + $(a - b)} |`; });
    return text(note + [
      `## replace_forecast (${side.toUpperCase()}): removed ${res.removed} plan row(s), inserted ${res.inserted}, kept ${res.kept} manual/closed-month row(s)`,
      ...(res.skipped.length ? ['', `Skipped ${res.skipped.length} row(s) dated in closed months: ${res.skipped.join('; ')}`] : []),
      '', `| Month | Entity | Before | After | Change |`, '|---|---|---|---|---|', ...tbl,
    ].join('\n'));
  }
);

server.tool(
  'get_settings',
  'Shared portal settings. "Books closed through": months up to and including it always show GL actuals in the cash flow, dashboard and scorecard; the forecast starts the month after, opening from its actual closing. Also lists AR/AP pipeline rows dated in closed months (they are left out of the forecast).',
  {},
  async () => {
    const { p } = await withPortal('conso');
    const s = p.get(`({set:typeof getSetting==='function'?getSetting('booksClosedThrough'):null,
      eff:typeof booksClosedOrd==='function'?mFromOrd(booksClosedOrd()):null, actual:E.map(mFull),
      late:typeof closedPipelineRows==='function'?closedPipelineRows():[]})`);
    if (!s.eff) return text('This portal version has no books-closed setting yet.');
    return text([
      '## Settings', '',
      `**Books closed through:** ${s.eff}${s.set ? '' : ' (auto — not set: every month before the current calendar month)'}`,
      `Imported actual months: ${s.actual[0]}–${s.actual[s.actual.length - 1]}`,
      '',
      s.late.length ? `⚠ ${s.late.length} pipeline row(s) fall in closed months (not in the forecast):` : 'No pipeline rows fall in closed months.',
      ...s.late.map(r => `- ${r.side} \`${r.id}\` ${r.name} (${r.entity}) · ${r.month} · ${$(r.amount)}${r.status ? ' · ' + r.status : ''}`),
    ].join('\n'));
  }
);

server.tool(
  'set_books_closed_through',
  'Set the shared "Books closed through" month (e.g. "Oct 2026"), or clear it (empty string) to go back to automatic (the month before the current calendar month). Changes the cash flow, dashboard and scorecard for everyone.',
  { month: z.string().describe("'Mon YYYY', e.g. 'Oct 2026'; empty to clear") },
  async ({ month }) => {
    const m = String(month || '').trim();
    if (m && !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/.test(m)) throw new Error(`Invalid month "${m}" — use 'Mon YYYY', e.g. 'Oct 2026'.`);
    const { p } = await withPortal('conso');
    if (!p.get(`typeof setSetting==='function'`)) throw new Error('This portal version has no books-closed setting.');
    const r = p.get(`(function(m){setSetting('booksClosedThrough',m||null);return {eff:mFromOrd(booksClosedOrd()),last:mFull(E[E.length-1])};})(${JSON.stringify(m)})`);
    const note = await sbPatch({ ct_map: p.get('CT_MAP') }, p);
    const warn = m && p.get(`mOrd(${JSON.stringify(m)})>mOrd(E[E.length-1])`) ? `\n⚠ ${m} is after the last imported month (${r.last}); months without GL data can't be shown as actuals.` : '';
    return text(note + `Books closed through: ${r.eff}${m ? '' : ' (auto)'}.` + warn);
  }
);

server.tool(
  'get_cf_transactions',
  'Transaction-level drill-down for an actual month: every GL cash transaction with date, contact, entity, amount, resolved display group, any override, and its tx_key (used by set_cf_override).',
  {
    entity: ENTITY,
    month: z.string().describe("Actual month: 'Jul' or 'Jul 2026' for 2026, 'Jan 2027' for later years"),
    direction: z.enum(['inflow', 'outflow']),
    group: z.string().optional().describe('Only transactions resolving to this display group'),
  },
  async ({ entity, month, direction, group }) => {
    const { p } = await withPortal(entity || 'conso');
    const txs = p.get(`(function(mo,isIn,grpF){
      if(typeof mKey==='function')mo=mKey(mo); // the portal keys 2026 months bare ('Jul'), other years 'Jan 2027'
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
    // The portal's own account list (what its CF tab shows): the template accounts plus any that exist only
    // in the imported Balance Sheets (e.g. Fixed Deposit - WIO, WIO - US Dollar). BH_BANKS/BC_BANKS alone
    // miss those, which understated cash by ~$200k.
    const d = p.get(`(function(){
      const rows=typeof _bankRowsFromImport==='function'?_bankRowsFromImport()
        :Object.entries(BH_BANKS).map(function(e){return {name:e[0],entity:'BH',v:e[1]};})
          .concat(Object.entries(BC_BANKS).map(function(e){return {name:e[0],entity:'BC',v:e[1]};}));
      return {months:typeof mFull==='function'?E.map(mFull):E.slice(), rows:rows, close:getD().close};
    })()`);
    const lines = ['## Bank account breakdown', '', `| Account | Entity | ${d.months.join(' | ')} |`, `|---|---|${d.months.map(() => '---').join('|')}|`];
    const tot = d.months.map(() => 0);
    for (const r of d.rows) {
      lines.push(`| ${r.name} | ${r.entity} | ${d.months.map((_, i) => { tot[i] += r.v[i] || 0; return $(r.v[i] || 0); }).join(' | ')} |`);
    }
    lines.push(`| **Total** | BH+BC | ${tot.map(v => `**${$(v)}**`).join(' | ')} |`);
    lines.push(`| _Difference vs cash flow closing_ | | ${tot.map((v, i) => Math.abs(v - (d.close[i] || 0)) < 0.5 ? '—' : `**${$(v - (d.close[i] || 0))}**`).join(' | ')} |`);
    const gaps = d.months.filter((_, i) => Math.abs(tot[i] - (d.close[i] || 0)) >= 0.5);
    if (gaps.length) lines.push('', `⚠ The accounts don't add up to the closing bank balance in ${gaps.join(', ')} — check that month's Balance Sheet import.`);
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
    const fin = p.get(`(function(f){if(f&&typeof mFull==='function')f.labels=f.months.map(mFull);return f;})((window._importedFin||{})[${JSON.stringify(entity + '_' + statement)}] || null)`);
    if (!fin) return text(`No imported ${statement.toUpperCase()} for ${entity.toUpperCase()}. Import it on the portal's Import tab or via import_xero_data.`);
    const lines = [
      `## ${entity.toUpperCase()} ${statement === 'bs' ? 'Balance Sheet' : 'P&L'} (${(fin.labels || fin.months).join(', ')})`,
      '',
      `| Line | ${(fin.labels || fin.months).join(' | ')} |`,
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
    const tomb = new Set(Object.keys(((row.ct_map || {})['__tomb__||ar_fcst'] || {}).ids || {}));
    const rows = (row.ar_fcst || []).filter(r => !tomb.has(String(r.id))).filter(r =>
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
    const tomb = new Set(Object.keys(((row.ct_map || {})['__tomb__||ap_fcst'] || {}).ids || {}));
    const rows = (row.ap_fcst || []).filter(r => !tomb.has(String(r.id))).filter(r =>
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

server.tool(
  'get_scorecard_numbers',
  "Weekly scorecard numbers as *JSON* (not markdown) for Growth OS to feed into the Monday scorecard. One flat object, USD numbers, margins as 0..1 fractions. `cash` is closing cash at the last actual month; `avg_outflow` is YTD average monthly outflow; `revenue_last_month` is P&L revenue for the last actual month strictly before asOf (or the latest actual month if asOf isn't after any); `month_revenue_actual`/`month_revenue_booked` are P&L revenue and booked AR (status ≠ Draft) for asOf's month; `plan_*` fields cover the window 1 Nov 2026 → asOf, carrying across year ends, with `plan_window` listing the months included (plan_net_profit uses per-month adj. net for actuals + forecast inflow−outflow for pure-forecast months, since the portal has no forecast P&L); `booked_next_month` is already-booked cash (status ≠ Draft) landing next month; `ar_over_30` is unpaid AR invoiced >30 days before asOf.",
  {
    asOf: z.string().describe("Date as YYYY-MM-DD. Determines the plan-window end and 'current month'."),
    entity: ENTITY,
  },
  async ({ asOf, entity }) => {
    const asOfDate = new Date(asOf);
    if (isNaN(asOfDate.getTime())) throw new Error(`Invalid asOf: ${asOf} (expected YYYY-MM-DD)`);
    const asOfYear = asOfDate.getUTCFullYear();
    const asOfMonthIdx = asOfDate.getUTCMonth();

    const { p } = await withPortal(entity || 'conso');

    const payload = p.get(`(function(asOfIso, asOfYear, asOfMonthIdx){
      const FY = Number(FCST_YEAR); // FCST_YEAR is a string in the portal; compare as numbers.
      const BOOKED = ['Invoiced','Partial','Overdue','Paid']; // only explicit statuses count as booked; blank = Draft
      // Actual-month keys: bare for FY ('Jan'), 'Mon YYYY' for other years ('Jan 2027'). Use the portal's
      // helpers when present; older portals only ever held FY months.
      const ordOf = k => typeof mOrd==='function' ? mOrd(k) : FY*12 + ALL_MONTHS.indexOf(k);
      const keyOf = full => typeof mKey==='function' ? mKey(full) : (full.slice(-4)===String(FY) ? full.slice(0,3) : full);
      // Only months up to "books closed through" count as actuals (the portal's rule); later months are forecast.
      const closedN = typeof closedCount==='function' ? closedCount() : E.length;
      const cf = getD();
      const pl = getPL();
      const bs = getBSMetrics();

      // Per-month P&L — read directly from the same template arrays getPL sums over.
      const src = ent==='bh'?BH_PL:ent==='bc'?BC_PL:CONSO_PL;
      const revLbl = ent==='bh'?'Total Trading Income':'Total Income';
      const netLbl = ent==='bh'?'Net Profit':ent==='bc'?'Net Income':'Net Profit / Income';
      const findRow = lbl => src.find(x=>x.label===lbl) || src.find(x=>x.label&&normKey(x.label).includes(normKey(lbl)));
      const toArr = row => (row && row.v) || Array(E.length).fill(0);
      const revByE = toArr(findRow(revLbl));
      const netByE = toArr(findRow(netLbl));
      const wagesByE = ent==='bc' ? Array(E.length).fill(0) : toArr(findRow('Wages and Salaries'));
      const adjNetByE = netByE.map((v,i)=>(v||0)+(wagesByE[i]||0));

      const asOfMonAbbr = ALL_MONTHS[asOfMonthIdx];
      const asOfMonFull = asOfMonAbbr + ' ' + asOfYear;
      const nextIdx = (asOfMonthIdx + 1) % 12;
      const nextYear = nextIdx === 0 ? asOfYear + 1 : asOfYear;
      const nextMonFull = ALL_MONTHS[nextIdx] + ' ' + nextYear;
      const entMatch = r => (ent==='conso') || ((r.entity||'BH').toUpperCase() === ent.toUpperCase());

      // revenue_last_month: last actual month strictly earlier than asOf; falls back to latest actual.
      let lastClosedIdx = -1;
      const asOfOrd = asOfYear*12 + asOfMonthIdx;
      for (let i = closedN-1; i >= 0; i--) {
        if (ordOf(E[i]) < asOfOrd) { lastClosedIdx = i; break; }
      }
      if (lastClosedIdx === -1 && closedN) lastClosedIdx = closedN - 1;
      const revenue_last_month = lastClosedIdx >= 0 ? (revByE[lastClosedIdx] || 0) : 0;

      const asOfEIdx = E.indexOf(keyOf(asOfMonFull));
      const month_revenue_actual = asOfEIdx >= 0 ? (revByE[asOfEIdx] || 0) : 0;

      // Booked = any AR that isn't explicitly Draft (matches the portal's forecast semantics —
      // a blank/missing status counts as invoiced for forecasting; Draft is the only exclusion).
      const bookedForMonth = (monthFull) => AR_FCST
        .filter(r => entMatch(r) && BOOKED.indexOf(r.status) >= 0 && normalizeCashMonth(r.invoiceMonth) === monthFull)
        .reduce((s,r) => s + (r.usdValue || r.amount || 0), 0);
      const month_revenue_booked = bookedForMonth(asOfMonFull);

      const month_inflow_fcst = getFcastInflow(asOfMonFull);
      const month_outflow_fcst = getFcastOutflow(asOfMonFull);

      // Plan window: 1 Nov 2026 through asOf's month (inclusive), walking across year ends so the
      // window keeps growing into 2027 and beyond. The start is the year plan's start, so it is
      // fixed rather than tied to FCST_YEAR. Capped at 36 months as a guard for a far-future asOf.
      const PLAN_START_YEAR = 2026, PLAN_START_MONTH = 10; // Nov 2026
      const planMonths = [];
      for (let y = PLAN_START_YEAR, mi = PLAN_START_MONTH;
           (y < asOfYear || (y === asOfYear && mi <= asOfMonthIdx)) && planMonths.length < 36;
           mi === 11 ? (mi = 0, y++) : mi++) {
        planMonths.push({ abbr: ALL_MONTHS[mi], year: y, full: ALL_MONTHS[mi] + ' ' + y });
      }

      let plan_revenue_actual = 0;
      let plan_net_profit = 0;
      let plan_revenue_booked = 0;
      for (const pm of planMonths) {
        const i = E.indexOf(keyOf(pm.full)); // an actual month of any year (2027 actuals included)…
        if (i >= 0 && i < closedN) {        // …that is closed
          plan_revenue_actual += (revByE[i] || 0);
          plan_net_profit     += (adjNetByE[i] || 0);
        } else {
          plan_net_profit     += getFcastInflow(pm.full) - getFcastOutflow(pm.full);
        }
        plan_revenue_booked += bookedForMonth(pm.full);
      }
      // plan_revenue_booked already includes actuals' invoiced-not-Draft; promote booked beneath actual when actual is higher so Monday never sees booked < actual.
      plan_revenue_booked = Math.max(plan_revenue_booked, plan_revenue_actual);

      const booked_next_month = AR_FCST
        .filter(r => entMatch(r) && BOOKED.indexOf(r.status) >= 0 && normalizeCashMonth(r.cashMonth) === nextMonFull)
        .reduce((s,r) => s + (r.cash || 0), 0);

      const asOfMs = new Date(asOfIso + 'T23:59:59Z').getTime();
      const THIRTY = 30 * 24 * 60 * 60 * 1000;
      const ar_over_30 = AR_FCST
        .filter(r => entMatch(r) && r.status && r.status !== 'Paid')
        .filter(r => { const t = r.invoiceDate ? new Date(r.invoiceDate).getTime() : NaN; return !isNaN(t) && (asOfMs - t) > THIRTY; })
        .reduce((s,r) => s + (r.cash || r.usdValue || r.amount || 0), 0);

      // YTD = the portal's reporting year (year of the latest actual month)
      const ytdIdx = typeof reportIdx==='function' ? reportIdx(dashYear()) : typeof yearIdx==='function' ? yearIdx(dashYear()) : cf.out.map((_,i)=>i);
      const avg_outflow = ytdIdx.length ? ytdIdx.reduce((s,i)=>s+cf.out[i],0) / ytdIdx.length : 0;

      return {
        cash: cf.close[cf.close.length-1] || 0,
        avg_outflow,
        receivables: bs.ar || 0,
        ar_over_30,
        revenue_last_month,
        month_revenue_actual,
        month_revenue_booked,
        month_inflow_fcst,
        month_outflow_fcst,
        plan_revenue_actual,
        plan_revenue_booked,
        plan_net_profit,
        booked_next_month,
        plan_window: planMonths.map(pm => pm.full),
        gross_margin: pl.gpPct || 0,
        net_margin: pl.adjNetPct || 0,
      };
    })(${JSON.stringify(asOf)}, ${asOfYear}, ${asOfMonthIdx})`);

    // JSON only — this tool is machine-consumed by Growth OS; the FOOTER text() helper is skipped on purpose.
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
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
    checkRowMonths(p, rows, ['cashMonth', 'invoiceMonth'], (r, i) => r.client || `row ${i + 1}`);
    const added = p.get(`(function(rows){
      const out=[];
      rows.forEach(function(r,_i){
        r.id=${NEW_ID};
        if(!r.source)r.source='manual';
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
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST') }, p);
    const warn = added.filter(r => !r.cashMonth).map(r => `⚠ ${r.client}: no cashMonth/paymentDate — will not show in any forecast month.`)
      .concat(rowWarnLines(p, 'AR', added, r => r.client));
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
    checkRowMonths(p, updates, ['cashMonth'], u => u.id);
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
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST') }, p);
    const touched = p.get(`AR_FCST.filter(function(r){return ${JSON.stringify(updates.map(u => String(u.id)))}.indexOf(String(r.id))>=0;})`);
    return text(note + ['## AR updates', '', ...log.map(l => '- ' + l), ...rowWarnLines(p, 'AR', touched, r => r.client)].join('\n'));
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
      if(typeof addTombs==='function')addTombs('ar_fcst',ids); // a stale client can never bring them back
      recomputeFcstMonths();
      return {gone:gone, removed:before-AR_FCST.length};
    })(${JSON.stringify(ids.map(String))})`);
    const note = await sbPatch({ ar_fcst: p.get('AR_FCST'), ct_map: p.get('CT_MAP') }, p);
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
    checkRowMonths(p, rows, ['cashMonth', 'workMonth'], (r, i) => r.vendor || `row ${i + 1}`);
    const added = p.get(`(function(rows){
      const out=[];
      rows.forEach(function(r,_i){
        r.id=${NEW_ID};
        if(!r.source)r.source='manual';
        if(!r.entity)r.entity='BH';
        recalcAPRow(r);
        AP_FCST.push(r); out.push(r);
      });
      recomputeFcstMonths();
      return out;
    })(${JSON.stringify(rows)})`);
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST') }, p);
    return text(note + ['## Added ' + added.length + ' AP row(s)', '', ...added.map(r => `- \`${r.id}\` ${r.vendor} (${r.entity}) · cash ${r.cashMonth || '—'} · ${$(r.amount)} · ${r.spendType || '—'}/${r.expenseCategory || '—'}`), ...rowWarnLines(p, 'AP', added, r => r.vendor)].join('\n'));
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
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST') }, p);
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
      if(typeof addTombs==='function')addTombs('ap_fcst',ids); // a stale client can never bring them back
      recomputeFcstMonths();
      return {gone:gone, removed:before-AP_FCST.length};
    })(${JSON.stringify(ids.map(String))})`);
    const note = await sbPatch({ ap_fcst: p.get('AP_FCST'), ct_map: p.get('CT_MAP') }, p);
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
    const note = await sbPatch({ ct_map: p.get('CT_MAP') }, p);
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
    const note = await sbPatch({ gl_mappings: p.get('GL_MAPPINGS'), actuals_snap: chk.snap }, p);
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
    const note = await sbPatch({ gl_mappings: p.get('GL_MAPPINGS'), actuals_snap: chk.snap }, p);
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
    const note = await sbPatch({ cf_tx_overrides: p.get('CF_TX_OVERRIDES'), cf_net_overrides: p.get('CF_NET_OVERRIDES') }, p);
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
    const note = await sbPatch({ actuals_snap: mergedActualsSnap(row, p).snap }, p);
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
  if (sid) {
    // Known session: route to it. Unknown session (e.g. after a server restart or deploy):
    // 404 tells the MCP client to re-initialize automatically — the previous behavior
    // of silently creating a fresh (uninitialized) transport returned -32000 on every
    // tool call until the user disconnected/reconnected the connector.
    const transport = transports[sid];
    if (!transport) { res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }); return; }
    await transport.handleRequest(req, res, req.body);
    return;
  }
  // No session id: this must be the initialize call that opens one.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { transports[id] = transport; },
  });
  transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
  await buildServer().connect(transport);
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
