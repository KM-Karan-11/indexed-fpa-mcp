// End-to-end test: connects to the local MCP server like Claude.ai would,
// exercises every read tool and dry-run-exercises the write tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL || 'http://localhost:3000/mcp');
const client = new Client({ name: 'test-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`, tools.map(t => t.name).join(', '));
console.log('═'.repeat(70));

let pass = 0, fail = 0;
async function call(name, args, expect) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const out = r.content?.[0]?.text || '';
    const ok = !r.isError && (!expect || expect.every(e => out.includes(e)));
    console.log(`${ok ? '✓' : '✗'} ${name}(${JSON.stringify(args).slice(0, 60)})`);
    if (!ok) { console.log('   OUTPUT:', out.slice(0, 400).replace(/\n/g, ' | ')); fail++; }
    else pass++;
    return out;
  } catch (e) {
    console.log(`✗ ${name} THREW: ${e.message.slice(0, 200)}`);
    fail++;
    return '';
  }
}

// ── Reads ──
const dash = await call('get_dashboard_metrics', {}, ['Founder cash earnings', 'Closing cash balance']);
console.log(dash.split('\n').slice(0, 9).join('\n'));
await call('get_dashboard_metrics', { entity: 'bh' }, ['Dashboard — BH']);
const cf = await call('get_cf_statement', {}, ['Cash flow statement', '| Month |']);
console.log(cf.split('\n').slice(2, 20).join('\n'));
await call('get_cf_statement', { mode: 'actuals' }, ['(actuals)']);
await call('get_cf_groups', { direction: 'inflow' }, ['Cash inflow by group']);
await call('get_cf_groups', { direction: 'outflow', entity: 'bh' }, ['Cash outflow by group']);
const txs = await call('get_cf_transactions', { month: 'Jul', direction: 'inflow' }, ['tx_key']);
console.log(txs.split('\n').slice(0, 5).join('\n'));
await call('get_bank_breakdown', {}, ['Bank account breakdown']);
await call('get_financials', { entity: 'bh', statement: 'pl' });
await call('get_financials', { entity: 'bh', statement: 'bs' });
const ar = await call('get_ar', {}, ['AR pipeline']);
console.log(ar.split('\n').slice(0, 4).join('\n'));
await call('get_ar', { status: 'Paid' });
await call('get_ap', {}, ['AP schedule']);
await call('get_contacts', {}, ['Mapped contacts']);
await call('get_comments', { include_resolved: true });
const hist = await call('get_client_history', { client: 'Veriheal' });
console.log(hist.split('\n').slice(0, 6).join('\n'));
await call('forecast_client_cash', { client: 'Veriheal' });

// ── Writes (server must be in DRY_RUN=1) ──
const arOut = await call('add_ar_rows', {
  rows: [{ client: 'TEST Dry Run Co', amount: 10000, fx: 1, fee: 100, invoiceDate: '2026-08-05', paymentDate: '2026-09-15' }],
}, ['DRY RUN', 'TEST Dry Run Co', 'Sep 2026']);
console.log(arOut);
// derived: usd 10000, interbank 1% = 100, cash = 10000-100-100 = 9800
if (arOut.includes('$9,800')) { console.log('✓ AR derived-cash math correct ($9,800)'); pass++; } else { console.log('✗ AR derived cash wrong — expected $9,800'); fail++; }

// pick a real AR row id and dry-run an update + delete
const idm = ar.match(/`([a-z0-9.]+)`/);
if (idm) {
  await call('update_ar_rows', { updates: [{ id: idm[1], notes: 'dry-run note' }] }, ['DRY RUN', 'AR updates']);
  await call('delete_ar_rows', { ids: [idm[1]] }, ['DRY RUN', 'Deleted 1']);
}
await call('add_ap_rows', { rows: [{ vendor: 'TEST Vendor', amount: 5000, paymentDate: '2026-08-20', spendType: 'variable', expenseCategory: 'opex' }] }, ['DRY RUN', 'Aug 2026', 'Variable/OPEX']);
await call('set_contact_mapping', { mappings: [{ contact: 'TEST Dry Run Co', entity: 'BH', group: 'Test Group', type: 'client' }] }, ['DRY RUN', 'Test Group']);
await call('set_gl_mapping', { entity: 'bh', statement: 'pl', add: [{ xero: 'Test Xero Acct', tmpl: 'Revenue' }] }, ['DRY RUN', 'mapped Test Xero Acct']);
await call('manage_dashboard_rows', { action: 'add', entity: 'bh', statement: 'pl', section: 'Operating Expenses', label: 'TEST Row' }, ['DRY RUN']);
const txkey = txs.match(/tx_key: `([^`]+)`/);
if (txkey) {
  await call('set_cf_override', { tx_key: txkey[1], display_group: 'Test Group' }, ['DRY RUN', 'display group -> Test Group']);
}
await call('add_comment', { cell_id: 'dash|kpi|closing-cash', cell_context: 'Test', body: 'test' }, ['DRY RUN']);
await call('resolve_comment', { cell_id: 'dash|kpi|closing-cash' }, ['DRY RUN']);

console.log('═'.repeat(70));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
