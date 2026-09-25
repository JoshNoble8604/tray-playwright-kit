/**
 * Empty a data table, or reset one back to a file.
 *
 * WHY. A demo that writes to tables is a demo that cannot be rehearsed twice.
 * After one run-through the tables hold the last run's rows, events are
 * duplicated, and the records that were meant to change during the demo have
 * already changed. The choice is then between
 * rebuilding the project by hand and showing a demo that starts halfway through.
 *
 *   npx tray-console reset-datatable <ws> <proj> <tableId> --empty --yes
 *   npx tray-console reset-datatable <ws> <proj> <tableId> --from rows.json --key sid --yes
 *
 * DESTRUCTIVE, so `--yes` is required and the row count is printed before and
 * after. `--from` empties and reloads, which is how a table with edited cells
 * (a status the demo advanced) gets put back rather than accumulating.
 *
 * Uses the console's own endpoints, same as rename-datatable-columns.mjs:
 *   GET    …/datatables/<id>            -> { columns: [{id, name}] }
 *   GET    …/datatables/<id>/rows       -> { elements: [{ id, properties }] }
 *   DELETE …/datatables/<id>/rows/<row>
 *   POST   …/datatables/<id>/rows       { properties: { <COLUMN ID>: value } }
 */
import { readFileSync } from "node:fs";
import { attach } from "./browser.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [workspaceId, projectId, tableId] = positional;
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? args[fromIdx + 1] : null;
const keyIdx = args.indexOf("--key");
const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
const empty = args.includes("--empty");
const confirmed = args.includes("--yes");

if (!workspaceId || !projectId || !tableId || (!empty && !from)) {
  throw new Error(
    "usage: reset-datatable <ws> <proj> <tableId> (--empty | --from rows.json [--key col]) --yes",
  );
}
if (!confirmed) {
  throw new Error("refusing to delete rows without --yes");
}

const wanted = from ? JSON.parse(readFileSync(from, "utf8")) : [];

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });

let auth = null;
page.on("request", (req) => {
  if (auth) return;
  if (!/api\.tray\.io\/(internal|private)/.test(req.url())) return;
  const header = req.headers().authorization;
  if (header && /^Bearer /.test(header)) auth = header;
});

await page.goto(
  `https://app.tray.io/workspaces/${workspaceId}/projects/${projectId}/data-tables/${tableId}`,
  { waitUntil: "domcontentloaded", timeout: 90_000 },
);
await page.waitForTimeout(12_000);
if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — session expired");
if (!auth) throw new Error("never saw an authenticated request — is this account signed in?");

const api = `https://api.tray.io/internal/v1/workspaces/${workspaceId}/projects/${projectId}/datatables/${tableId}`;

async function call(method, url, body) {
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
        /* 204 and error pages are not JSON */
      }
      return { status: res.status, json };
    },
    [url, method, auth, body ?? null],
  );
}

const table = (await call("GET", api)).json;
if (!table) throw new Error("could not read the table");
const idOf = Object.fromEntries((table.columns ?? []).map((c) => [c.name, c.id]));
const readRows = async () => (await call("GET", `${api}/rows?first=1000`)).json?.elements ?? [];

const before = await readRows();
console.log(`\n  ${table.name} — ${before.length} row(s)`);

let deleted = 0;
for (const r of before) {
  const res = await call("DELETE", `${api}/rows/${r.id}`);
  if (res.status >= 200 && res.status < 300) deleted++;
  else console.log(`  ! could not delete row ${r.id} — HTTP ${res.status}`);
}
console.log(`  deleted ${deleted}`);

let added = 0;
if (from) {
  const unknown = [...new Set(wanted.flatMap((r) => Object.keys(r)))].filter((k) => !idOf[k]);
  if (unknown.length) throw new Error(`${from} names unknown column(s): ${unknown.join(", ")}`);
  for (const row of wanted) {
    const byId = {};
    for (const [name, value] of Object.entries(row)) byId[idOf[name]] = value;
    const res = await call("POST", `${api}/rows`, { properties: byId });
    if (res.status >= 200 && res.status < 300) added++;
  }
  console.log(`  reloaded ${added} from ${from}`);
}

// VERIFY BY RE-READING. A 2xx on a write the server ignored looks exactly like
// one it applied — an easy trap to fall into repeatedly.
const after = await readRows();
console.log(`  table now holds ${after.length} row(s)\n`);

await page.close();
const expected = from ? wanted.length : 0;
process.exit(after.length === expected ? 0 : 1);
