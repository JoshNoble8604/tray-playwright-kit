/**
 * Read a Helix app's logs — the same list the Logs tab at app.helix.tray.ai shows.
 *
 *   tray-console helix-logs <helix-logs-url | workspaceId projectId> [options]
 *
 *   --since 24h      window: 30m, 24h, 7d (default 24h)
 *   --errors         only executions that did not succeed
 *   --grep <text>    only routes/jobs containing text
 *   --limit <n>      at most n rows (default 50)
 *   --id <execId>    one execution in full: request, response, operations
 *   --json           raw JSON instead of a table
 *
 * WHY THROUGH THE BROWSER. The Helix CLI has no logs command and the endpoint is
 * private, so this lifts the console's own bearer from its own traffic, exactly
 * as rename-datatable-columns does. Needs `tray-console browser`, signed in.
 */
import { attach } from "./browser.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && /^--(since|grep|limit|id)$/.test(argv[i - 1])));

let workspaceId, projectId;
const m = positional[0]?.match(/workspaces\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})/);
if (m) [, workspaceId, projectId] = m;
else [workspaceId, projectId] = positional;
if (!workspaceId || !projectId) {
  console.error("usage: tray-console helix-logs <helix-logs-url | workspaceId projectId> [--since 24h] [--errors] [--grep text] [--limit n] [--id execId] [--json]");
  process.exit(1);
}

const since = opt("since", "24h");
const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[since.slice(-1)];
if (!unit || !(parseFloat(since) > 0)) throw new Error(`--since wants 30m, 24h or 7d, not '${since}'`);
const sinceIso = new Date(Date.now() - parseFloat(since) * unit).toISOString();
const limit = Number(opt("limit", 50));

const { context } = await attach();
const page = await context.newPage();

/** The console's own bearer. Never logged. */
let auth = null;
page.on("request", (req) => {
  const h = req.headers().authorization;
  if (!auth && /api\.tray\.io\/private/.test(req.url()) && h?.startsWith("Bearer ")) auth = h;
});

try {
  await page.goto(`https://app.helix.tray.ai/workspaces/${workspaceId}/projects/${projectId}/logs`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  for (let i = 0; i < 30 && !auth; i++) await page.waitForTimeout(500);
  if (/\/login|\/signin|id\.tray\.ai/i.test(page.url())) throw new Error("bounced to sign-in — sign in in the tray-console browser");
  if (!auth) throw new Error("never saw an authenticated request — is this account signed in to Helix?");

  const base = `https://api.tray.io/private/v1/code/workspaces/${workspaceId}/projects/${projectId}/executions`;
  const get = (url) =>
    page.evaluate(async ([url, auth]) => {
      const r = await fetch(url, { headers: { authorization: auth } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    }, [url, auth]);

  const id = opt("id");
  if (id) {
    console.log(JSON.stringify(await get(`${base}/${id}`), null, 2));
  } else {
    // Same query params the Logs tab sends; the server filters, we only page.
    const filters = { since: sinceIso, ...(flag("errors") && { hasError: "true" }), ...(opt("grep") && { query: opt("grep") }) };
    const rows = [];
    let cursor = null;
    do {
      const q = new URLSearchParams({ first: "50", ...filters, ...(cursor && { cursor }) });
      const res = await get(`${base}?${q}`);
      rows.push(...(res.elements ?? []));
      cursor = res.pageInfo?.hasNextPage ? res.pageInfo.endCursor : null;
    } while (cursor && rows.length < limit);
    rows.length = Math.min(rows.length, limit);

    if (flag("json")) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log(`no executions in the last ${since}`);
    else
      for (const e of rows)
        console.log(
          [new Date(e.startedAt).toLocaleString(), e.status.padEnd(8), (e.triggerType ?? "").padEnd(5),
           (e.routeOrJob ?? "").padEnd(40), `${e.durationMs}ms`.padStart(8), e.executionId].join("  "),
        );
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
} finally {
  // process.exit, never browser.close(): the browser is the user's.
  await page.close();
  process.exit();
}
