# Indexed FP&A — MCP Server

Gives Claude full read/write access to the Indexed FP&A portal's data — everything a person can do manually on the portal, through conversation.

## How it works

The server runs the portal itself, headlessly. On every tool call it:

1. Fetches the live `forecast_data` row from Supabase (same row the portal syncs).
2. Loads the portal's `index.html` (from GitHub Pages, cached 5 min) and executes its `<script>` inside a sandboxed VM with a fake DOM, seeding the fake `localStorage` from the cloud row — exactly how a browser session hydrates.
3. Calls the portal's **own functions** (`getD`, `buildCFGroups`, `getFounderPayments`, `recalcARRow`, `parseXeroAccountTx`, …) to compute answers or apply changes.
4. For writes, PATCHes **only the touched columns** back to Supabase (`ar_fcst`, `ap_fcst`, `ct_map`, `gl_mappings`, `cf_tx_overrides`, `cf_net_overrides`, `actuals_snap`).

Because the portal's own code computes everything, the numbers Claude reports are always identical to what the portal shows — and when the portal's logic changes, the server picks it up automatically on the next HTML refresh. No drift, no re-implementation.

## Tools (25)

**Read** — `get_dashboard_metrics`, `get_cf_statement`, `get_cf_groups`, `get_cf_transactions`, `get_bank_breakdown`, `get_financials`, `get_ar`, `get_ap`, `get_client_history`, `get_contacts`, `get_comments`

**Analysis** — `forecast_client_cash` (collection-rate based cash proposals)

**Write** — `add/update/delete_ar_rows`, `add/update/delete_ap_rows`, `set_contact_mapping`, `set_gl_mapping`, `manage_dashboard_rows`, `set_cf_override`, `import_xero_data`, `add_comment`, `resolve_comment`

## Run locally

```bash
npm install
npm start                      # port 3000
DRY_RUN=1 npm start            # writes are logged, not sent — safe testing
node test-client.js            # full test suite against localhost:3000
```

No env vars needed — Supabase config is extracted from the portal source. Comment tools additionally need `SUPABASE_SERVICE_KEY` (see `.env.example`).

## Deploy (Railway — recommended)

Needs a full Node runtime (uses the `vm` module and `fetch`), so a container host works; edge platforms (Cloudflare Workers, Vercel Edge) do **not**.

```bash
npm i -g @railway/cli
cd indexed-fpa-mcp
railway login          # opens browser
railway init           # create a project
railway up             # build + deploy this folder (no GitHub needed)
railway domain         # generate a public HTTPS URL
```

Then set environment variables (Railway dashboard → Variables, or `railway variables set`):

| Variable | Required | Purpose |
|---|---|---|
| `MCP_AUTH_TOKEN` | **yes for prod** | Comma-separated per-person tokens, each `label:token` — e.g. `karan:abc123,anjan:def456`. Any match authorizes; revoke one person by deleting their entry and redeploying. |
| `SUPABASE_SERVICE_KEY` | for comment tools | service_role key (Supabase → Settings → API). |

Generate a token per person: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

Verify: `curl https://<app>.railway.app/health` → `{"status":"ok",...}`.

## Access control — restricting to specific people

Two layers, together, mean only people you personally hand a token to can use it:

1. **Server token gate** — `/mcp` rejects any request without a valid token (401). Each person gets their own.
2. **Personal connector in Claude.ai** — each authorized person adds the connector to *their own* account with *their own* token in the URL. It is never published to an org directory, so nobody else can discover or add it.

To revoke someone: remove their `label:token` entry from `MCP_AUTH_TOKEN` and redeploy. Everyone else is unaffected.

## Connect to Claude.ai

Each person, in their own account: Settings → Connectors → Add custom connector. URL (their own token):

```
https://<app>.railway.app/mcp?token=<their-token>
```

(The server also accepts the token as an `Authorization: Bearer` header.)

## Notes

- `GET /health` hydrates a full portal session and reports the actual months — good smoke test.
- The portal auto-pushes its **entire state** when a user edits there. If someone keeps a stale portal tab open for hours and then edits, their push can overwrite changes made through Claude in the meantime. Refreshing the portal (or "Pull latest") before editing avoids this — same rule as between two human users.
- Xero imports through Claude: attach the Xero .xlsx in chat, Claude converts the sheet to raw rows and calls `import_xero_data`; the portal's own parser processes them.
