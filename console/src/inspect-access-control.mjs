/**
 * Read a project's API Management access control — clients, roles and policies.
 *
 * WHY: registering an operation is only half the job. A freshly registered operation answers
 * 403, not 404: it exists, but no client is authorised for it. `register-via-api.mjs` says
 * plainly that 403 means "exists but the client is not authorised", and then stops — there was
 * no script for the next step, and the README recorded access control as having no API at all.
 *
 * The console's Access Control screen has three tabs, and the model behind them is:
 *
 *     Client  --has-->  Role  --grants-->  Policy  --allows-->  Operation(s)
 *
 * So authorising a new operation is not a property of the operation. It is a change to the
 * policy behind the role the client already holds.
 *
 * This script only READS. Run it before anything that writes, per the kit's own rule: an
 * inspector first, field-by-field, off the screen rather than inferred.
 *
 *   npx tray-console inspect-access-control [env]
 */
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const envName = process.argv.slice(2).find((a) => !a.startsWith("--"));
const env = await environment(envName);

const { context } = await attach();
const page = await context.newPage();
// 1500×1300 is load-bearing across this kit — the create forms run past the fold at 950px and
// Playwright then refuses to click, reporting "outside of the viewport", which reads like a
// selector bug and is not.
await page.setViewportSize({ width: 1500, height: 1300 });

/** The console's own bearer, lifted from its own traffic. Never logged, never stored. */
let auth = null;
page.on("request", (r) => {
  if (auth) return;
  if (!/api\.tray\.io\/private/.test(r.url())) return;
  const h = r.headers().authorization;
  if (h && /^Bearer /.test(h)) auth = h;
});

await page.goto(
  `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/access-control`,
  { waitUntil: "domcontentloaded", timeout: 90_000 },
);
await page.waitForTimeout(8000);
if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");
if (!auth) throw new Error("never saw the console send an Authorization header to api.tray.io/private");

/** Candidate paths under the project's private API. Unknown ones answer 404 and cost nothing. */
const CANDIDATES = ["api/clients", "api/roles", "api/policies", "api/operations", "api/access-control"];

const found = await page.evaluate(
  async ({ projectId, a, paths }) => {
    const out = {};
    for (const p of paths) {
      try {
        const r = await fetch(`https://api.tray.io/private/v1/projects/${projectId}/${p}`, {
          credentials: "include",
          headers: { accept: "application/json", authorization: a },
        });
        out[p] = { status: r.status, body: (await r.text()).slice(0, 1200) };
      } catch (e) {
        out[p] = { status: "threw", body: String(e).slice(0, 200) };
      }
    }
    return out;
  },
  { projectId: env.projectId, a: auth, paths: CANDIDATES },
);

for (const [path, res] of Object.entries(found)) {
  console.log(`\n── ${path} → ${res.status}`);
  if (res.status === 200) console.log(res.body);
}
await page.close();
