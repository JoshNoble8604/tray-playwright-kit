/**
 * Load rows into a data table from a JSON file, through the console's own API.
 *
 * WHY, given that the MCP server has `datatable_create_row`. It takes one row
 * per call. Seeding a demo is tens to hundreds of rows, and paying a round trip
 * each makes reloading the corpus something you avoid doing — which is how a
 * demo's data drifts from the file it was supposed to be generated from.
 *
 * Same route as rename-datatable-columns.mjs:
 *
 *   GET  api.tray.io/internal/v1/workspaces/<ws>/projects/<proj>/datatables/<id>
 *   GET  (same)/rows?first=N    -> { elements: [{ id, properties: { <COLUMN ID>: v }}] }
 *   POST (same)/rows            { "properties": { "<COLUMN ID>": "<value>" } }
 *
 * BOTH ENDS ARE KEYED BY COLUMN ID, NOT NAME. Posting names answers
 * `400 Invalid column ids sid provided in properties` — established by probing
 * rather than by guessing, after the first attempt failed 25 times in a row with
 * an empty 400 body.
 *
 * The FILE is keyed by column name, because a file full of `ABCDEF-123456` is
 * not reviewable and does not survive the table being rebuilt. This script does
 * the translation, and refuses the run if the file names a column the table does
 * not have — a typo that silently drops a field is worse than a failure.
 *
 * IDEMPOTENT ON A KEY. Pass --key <column> and rows whose key already exists are
 * skipped rather than duplicated. Without it, running twice doubles the table.
 *
 *   npx tray-console load-datatable-rows <ws> <proj> <tableId> <rows.json> [--key sid]
 *
 * rows.json is an array of flat objects: [{ "sid": "SID0073457", ... }, ...]
 */
import { readFileSync } from "node:fs";
import { attach } from "./browser.mjs";

const args = process.argv.slice(2);
const [workspaceId, projectId, tableId, rowsPath] = args.filter((a) => !a.startsWith("--"));
const keyIdx = args.indexOf("--key");
const key = keyIdx >= 0 ? args[keyIdx + 1] : null;

if (!workspaceId || !projectId || !tableId || !rowsPath) {
  throw new Error(
    "usage: load-datatable-rows <ws> <proj> <tableId> <rows.json> [--key <column>]",
  );
}

const wanted = JSON.parse(readFileSync(rowsPath, "utf8"));
if (!Array.isArray(wanted) || !wanted.length) throw new Error(`${rowsPath} is not a non-empty array`);

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

await page.goto(
  `https://app.tray.io/workspaces/${workspaceId}/projects/${projectId}/data-tables/${tableId}`,
  { waitUntil: "domcontentloaded", timeout: 90_000 },
);
await page.waitForTimeout(12_000);
if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — session expired");
if (!auth) throw new Error("never saw an authenticated request — is this account signed in?");

const api = `https://api.tray.io/internal/v1/workspaces/${workspaceId}/projects/${projectId}/datatables/${tableId}`;

/** Issued from inside the authenticated page: Node's fetch gets an error page. */
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
        /* an error page, not JSON */
      }
      return { status: res.status, json, text: json ? null : text.slice(0, 300) };
    },
    [url, method, auth, body ?? null],
  );
}

const table = await call("GET", api);
if (table.status !== 200 || !table.json) {
  throw new Error(`could not read the table (HTTP ${table.status}): ${table.text ?? ""}`);
}
const columns = (table.json.columns ?? []).map((c) => c.name);
console.log(`\n  ${table.json.name} — columns: ${columns.join(", ")}`);

// Refuse on an unknown column rather than posting a row with a field silently
// dropped. A partial row looks like a row.
const unknown = [...new Set(wanted.flatMap((r) => Object.keys(r)))].filter(
  (k) => !columns.includes(k),
);
if (unknown.length) {
  throw new Error(
    `${rowsPath} mentions column(s) this table does not have: ${unknown.join(", ")}`,
  );
}
if (key && !columns.includes(key)) throw new Error(`--key ${key} is not a column`);

// name -> id, for translating the file on the way in and the table on the way out.
const idOf = Object.fromEntries((table.json.columns ?? []).map((c) => [c.name, c.id]));

async function readRows() {
  const res = await call("GET", `${api}/rows?first=1000`);
  return res.json?.elements ?? [];
}

let existing = new Set();
if (key) {
  for (const r of await readRows()) {
    const v = (r.properties ?? {})[idOf[key]];
    if (v) existing.add(String(v));
  }
  console.log(`  ${existing.size} row(s) already present, keyed on ${key}`);
}

let added = 0;
let skipped = 0;
let failed = 0;
for (const row of wanted) {
  if (key && existing.has(String(row[key]))) {
    skipped++;
    continue;
  }
  const byId = {};
  for (const [name, value] of Object.entries(row)) byId[idOf[name]] = value;
  const res = await call("POST", `${api}/rows`, { properties: byId });
  if (res.status >= 200 && res.status < 300) {
    added++;
  } else {
    failed++;
    console.log(`  ! ${key ? row[key] : JSON.stringify(row).slice(0, 60)} — HTTP ${res.status} ${res.text ?? ""}`);
  }
}

// VERIFY BY RE-READING. A 2xx on a write the server partly ignored looks exactly
// like a 2xx on one it applied — which is how the column rename first "worked".
const finalCount = (await readRows()).length;

console.log(`\n  added ${added}, skipped ${skipped}, failed ${failed}`);
console.log(`  table now holds ${finalCount} row(s)\n`);

await page.close();
process.exit(failed ? 1 : 0);
