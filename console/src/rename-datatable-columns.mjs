/**
 * Rename a data table's columns, through the endpoint the console itself uses.
 *
 * WHY THIS EXISTS. `datatable_create` takes a column COUNT, not names, and
 * neither the public API nor any Tray MCP server can rename a column — so a
 * table built from a script comes out as `Column 1 … Column N` and stays that
 * way. That is not cosmetic. The `data-tables` connector resolves its `column`
 * field by NAME through a DDL, so every step that reads the table says
 * `Column 3`, and a table shown on screen looks half-finished.
 *
 * "There is no API" turned out to mean "it is not in the public spec". The
 * console's data-table screen talks to:
 *
 *   GET  api.tray.io/internal/v1/workspaces/<ws>/projects/<proj>/datatables/<id>
 *   PUT  (same)/columns/<columnId>     { "name": "..." }     — ONE PER COLUMN
 *
 * found by driving the header in the UI and recording what it sent — the same
 * route that produced register-via-api.mjs.
 *
 * THE OBVIOUS GUESS IS WRONG AND FAILS SILENTLY. PATCHing the datatable itself
 * with a `columns: [{id, name}]` array answers **HTTP 200 and changes nothing**.
 * That was tried first, and only re-reading the table caught it — which is why
 * this verifies by re-reading and never by the status of the write.
 *
 * Internal endpoint: treat it as unstable.
 *
 * The bearer is the console's own, lifted from a request the app made itself.
 * Nothing is invented, stored or printed.
 *
 *   npx tray-console rename-datatable-columns <ws> <proj> <tableId> name1,name2,...
 *   npx tray-console rename-datatable-columns <ws> <proj> <tableId> --show
 */
import { attach } from "./browser.mjs";

const [workspaceId, projectId, tableId, namesArg] = process.argv.slice(2);
if (!workspaceId || !projectId || !tableId || !namesArg) {
  throw new Error(
    "usage: rename-datatable-columns <ws> <proj> <tableId> <comma,separated,names | --show>",
  );
}
const showOnly = namesArg === "--show";
const wanted = showOnly ? [] : namesArg.split(",").map((s) => s.trim());

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });

/** The console's own bearer, lifted from the console's own traffic. Never logged. */
let auth = null;
page.on("request", (req) => {
  if (auth) return;
  if (!/api\.tray\.io\/(internal|private)/.test(req.url())) return;
  const header = req.headers().authorization;
  if (header && /^Bearer /.test(header)) auth = header;
});

const base = `https://app.tray.io/workspaces/${workspaceId}/projects/${projectId}`;
await page.goto(`${base}/data-tables/${tableId}`, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});
await page.waitForTimeout(12_000);
if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — session expired");
if (!auth) throw new Error("never saw an authenticated request — is this account signed in?");

const api = `https://api.tray.io/internal/v1/workspaces/${workspaceId}/projects/${projectId}/datatables/${tableId}`;

/**
 * Issued from inside the authenticated page, so the request carries the
 * console's origin and cookies as well as the bearer. Called from Node with
 * fetch, several of these answered with an error page.
 */
async function call(method, body, url = api) {
  return page.evaluate(
    async ([url, method, auth, body]) => {
      const res = await fetch(url, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        credentials: "include",
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an error page, not JSON */
      }
      return { status: res.status, json, text: json ? null : text.slice(0, 400) };
    },
    [url, method, auth, body ?? null],
  );
}

const before = await call("GET");
if (before.status !== 200 || !before.json) {
  throw new Error(`could not read the table (HTTP ${before.status}): ${before.text ?? ""}`);
}
const cols = before.json.columns ?? [];
console.log(`\n  ${before.json.name} — ${cols.length} columns`);
for (const c of cols) console.log(`    ${c.id}  ${c.name}`);

if (showOnly) {
  console.log("");
  await page.close();
  process.exit(0);
}

if (wanted.length !== cols.length) {
  throw new Error(
    `given ${wanted.length} names for ${cols.length} columns — refusing to guess which is which`,
  );
}

// Renaming by POSITION, which is the only ordering the create call guaranteed.
// One PUT per column — there is no bulk form, and the array-shaped PATCH that
// looks like one is the silent no-op described above.
console.log("");
for (const [i, c] of cols.entries()) {
  if (c.name === wanted[i]) {
    console.log(`  = ${wanted[i]} (already)`);
    continue;
  }
  const res = await call("PUT", { name: wanted[i] }, `${api}/columns/${c.id}`);
  console.log(`  ${res.status === 200 ? "→" : "!"} ${c.name} → ${wanted[i]}  (HTTP ${res.status})${res.text ? " " + res.text : ""}`);
}

// VERIFY BY RE-READING, never by the response to the write. A 200 on a PATCH
// the server partly ignored looks exactly like a 200 on one it applied.
const after = await call("GET");
const got = (after.json?.columns ?? []).map((c) => c.name);
const ok = wanted.every((n, i) => got[i] === n);

console.log(`\n  now:`);
for (const c of after.json?.columns ?? []) console.log(`    ${c.id}  ${c.name}`);
console.log(ok ? "\n  ✅ renamed and verified\n" : "\n  ❌ table does not match what was asked for\n");

await page.close();
process.exit(ok ? 0 : 1);
