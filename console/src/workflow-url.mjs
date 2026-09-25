/**
 * The public URL of a webhook-triggered workflow.
 *
 * WHY THIS EXISTS. The Build API does not expose it, and the cost is real: a
 * workflow's webhook URL has to be copied out of the trigger step by hand, so every build
 * ends with a manual paste and a placeholder that ships if anybody forgets.
 *
 * The console has an endpoint for it, used on every workflow page load:
 *
 *   GET api.tray.io/v1/workflow-url/<workflowId>
 *
 * A callable workflow has no URL at all — that is not a gap in this script, it
 * is what callable means. Looking for one is looking for a field that does not
 * exist, which has cost real time twice.
 *
 *   npx tray-console workflow-url <ws> <proj> <workflowId> [<workflowId> ...]
 */
import { attach } from "./browser.mjs";

const [workspaceId, projectId, ...ids] = process.argv.slice(2);
if (!workspaceId || !projectId || !ids.length) {
  throw new Error("usage: workflow-url <ws> <proj> <workflowId> [<workflowId> ...]");
}

const { context } = await attach();
const page = await context.newPage();

let auth = null;
page.on("request", (req) => {
  if (auth) return;
  if (!/api\.tray\.io/.test(req.url())) return;
  const header = req.headers().authorization;
  if (header && /^Bearer /.test(header)) auth = header;
});

// Land on a workflow page so the app makes an authenticated call we can learn
// the bearer from. Any workflow will do; the first id is convenient.
await page.goto(
  `https://app.tray.io/workspaces/${workspaceId}/projects/${projectId}/workflows/${ids[0]}`,
  { waitUntil: "domcontentloaded", timeout: 90_000 },
);
await page.waitForTimeout(14_000);
if (!auth) throw new Error("never saw an authenticated request — is this account signed in?");

for (const id of ids) {
  const r = await page.evaluate(
    async ([id, auth]) => {
      const res = await fetch(`https://api.tray.io/v1/workflow-url/${id}`, {
        headers: { authorization: auth },
        credentials: "include",
      });
      const t = await res.text();
      try {
        return { status: res.status, json: JSON.parse(t) };
      } catch {
        return { status: res.status, text: t.slice(0, 200) };
      }
    },
    [id, auth],
  );
  const url = r.json?.public_url ?? null;   // the field is `public_url`
  console.log(`  ${id}  ${url ?? `(no url — HTTP ${r.status}) ${JSON.stringify(r.json ?? r.text)}`}`);
}
await page.close();
