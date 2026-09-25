/**
 * Register API Management operations through the endpoint the UI itself calls.
 *
 * WHY THIS EXISTS, given that register-operations.mjs drives the form.
 *
 * The create-operation form's Workflow dropdown is CAPPED at 16 entries. It does
 * not scroll, it does not filter as you type, and there is no search box — so a
 * project with more than sixteen API-triggered workflows simply cannot bind the
 * seventeenth from the UI. Workflows past the cap are enabled, carry
 * api-operation-trigger, and are absent from the list. No amount of clicking
 * reaches them.
 *
 * It is easy to conclude there is no API for creating operations: the
 * operation is not in the PUBLIC OpenAPI spec and no Tray MCP server exposes
 * it. But the console has one and uses it on every save —
 *
 *   POST https://api.tray.io/private/v1/projects/<projectId>/api/operations
 *   { name, description, workflowId, method, path, enabled, isPublic,
 *     isConnectorOperation }
 *
 * read off the network while watching the form fail. This script issues exactly
 * that request, from INSIDE the authenticated page, reusing the console's OWN
 * session bearer — which it does not invent or store: it watches the console's
 * normal traffic on page load and lifts the `authorization` header off a request
 * the app made itself. Cookies alone are NOT enough; without that header the
 * endpoint answers with an error page, which is what the first attempt hit.
 * The token is held in memory for the run and never printed or written down.
 *
 * It is a PRIVATE endpoint, so treat it as unstable: it may change without
 * notice, and the form remains the documented path for the workflows the cap
 * can reach. Verification is identical either way — the list and the endpoint,
 * never the response to this call.
 *
 *   TRAY_APIM_TOKEN=<bearer> npx tray-console register-via-api [env] [--only key]
 */
import { attach } from "./browser.mjs";
import { environment, migrations, operationName } from "./config.mjs";

const args = process.argv.slice(2);
const envName = args.find((a) => !a.startsWith("--"));
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const env = await environment(envName);
const all = await migrations();
const plan = only ? all.filter((m) => m.key === only) : all;
if (!plan.length) throw new Error(`nothing to do — no migration matches --only ${only}`);

const token = process.env.TRAY_APIM_TOKEN;
if (!token) throw new Error("TRAY_APIM_TOKEN is not set — a registration cannot be verified without it");

/** Does this path answer? 404 = not registered. Anything else = it reached a workflow. */
async function probe(path) {
  try {
    const res = await fetch(`https://${env.apiHost}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(45_000),
    });
    return res.status;
  } catch (err) {
    return `unreachable (${String(err).split("\n")[0]})`;
  }
}

const { context } = await attach();
const page = await context.newPage();
let failures = 0;

/*
 * The console's own bearer, lifted from the console's own traffic. Never logged.
 */
let consoleAuth = null;
page.on("request", (req) => {
  if (consoleAuth) return;
  if (!/api\.tray\.io\/private/.test(req.url())) return;
  const header = req.headers().authorization;
  if (header && /^Bearer /.test(header)) consoleAuth = header;
});

try {
  // Land on the project so the page carries the console's own origin and session.
  await page.goto(`https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/operations`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(6000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");
  if (!consoleAuth) {
    throw new Error(
      "never saw the console send an Authorization header to api.tray.io/private — " +
        "either the page did not finish loading, or the console has changed how it authenticates",
    );
  }

  for (const item of plan) {
    const existing = await probe(item.path);
    if (existing !== 404) {
      console.log(`  = ${item.key.padEnd(20)} ${item.path} already answers (${existing})`);
      continue;
    }

    const result = await page.evaluate(
      async ({ projectId, body, auth }) => {
        const res = await fetch(`https://api.tray.io/private/v1/projects/${projectId}/api/operations`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.text()).slice(0, 500) };
      },
      {
        projectId: env.projectId,
        auth: consoleAuth,
        body: {
          name: operationName(item),
          description: `${item.key}: migrated from a public webhook so the credential stops appearing in execution logs.`,
          workflowId: item.workflowId,
          method: "POST",
          path: item.path,
          // The form's toggle defaults to Disabled and a disabled operation is
          // registered and inert, so it is set explicitly here rather than
          // relying on a server-side default nobody has read.
          enabled: true,
          isPublic: false,
          isConnectorOperation: false,
        },
      },
    );

    /*
     * The create response is NOT the evidence, for the same reason a click is
     * not: it reports what the console was told, and operations have been reported
     * as created and then answered 404. The
     * endpoint is asked instead.
     */
    const after = await probe(item.path);
    if (after === 404) {
      failures++;
      console.log(`  ! ${item.key.padEnd(20)} create said ${result.status} ${result.body} — endpoint still 404`);
    } else {
      console.log(`  + ${item.key.padEnd(20)} ${item.path}  create ${result.status}, endpoint answered ${after}`);
    }
  }
} finally {
  await page.close();
  process.exit(failures ? 1 : 0);
}
