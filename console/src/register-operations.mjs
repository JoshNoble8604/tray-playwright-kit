/**
 * Register the API Management operations for migrated workflows.
 *
 * The one step of an APIM migration with no API behind it: a form at
 * /workspaces/<ws>/projects/<pj>/operations. A dozen workflows times however
 * many environments is why this is a script rather than an afternoon.
 *
 * WHAT THE FORM ACTUALLY IS (read off it on 2026-08-26, not inferred):
 *
 *   API availability   a toggle that DEFAULTS TO DISABLED
 *   Workflow *         a dropdown
 *   Name *             text
 *   Description        text
 *   Method *           GET | POST | PUT | PATCH | DELETE
 *   Path *             text, must start with /
 *
 * Two things that recon settled and would otherwise have been guesses:
 *
 *  1. **The dropdown only lists workflows that already carry an
 *     api-operation-trigger or agent-tool-trigger.** Every entry it offered was
 *     one of those; not one of the webhook workflows appeared. So the trigger
 *     swap MUST happen first — you cannot pre-register operations and migrate
 *     afterwards.
 *  2. **Availability defaults to Disabled.** Register a batch of operations
 *     without touching that toggle and you get endpoints that exist,
 *     look registered in the list, and answer nothing. This script enables it
 *     explicitly and refuses to save if it cannot.
 *
 * VERIFIED BY THE ENDPOINT, NOT BY THE FORM. After each save it calls the
 * operation with the APIM bearer and asserts the reply is not a 404. "The form
 * submitted" and "the endpoint exists" are different claims and only the second
 * one matters — a UI script that trusts its own clicks is how you get a batch of
 * silent failures.
 *
 *   npx tray-console register-operations [environment] [--dry-run] [--only key]
 */
import { writeFileSync } from "node:fs";
import { attach } from "./browser.mjs";
import { environment, migrations, operationName } from "./config.mjs";

const args = process.argv.slice(2);
const envName = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const env = await environment(envName);
const all = await migrations();
const plan = only ? all.filter((m) => m.key === only) : all;
if (plan.length === 0) throw new Error(`nothing to do — no migration matches --only ${only}`);

const OPS_URL = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/operations`;
const results = [];
let fatal = null;

/**
 * Call the operation with the APIM bearer and report what it answers.
 *
 * The only question asked is "does this path exist": 404 means it does not.
 * Anything else — 200, 4xx from the workflow's own validation, 500 — means the
 * request reached a workflow, which is what registration was for. The body is
 * deliberately empty so this never does the workflow's real work.
 */
async function probeEndpoint(path) {
  const token = process.env.TRAY_APIM_TOKEN;
  if (!token) {
    throw new Error(
      "TRAY_APIM_TOKEN is not set, so a registration cannot be verified against the endpoint. " +
        "Export the APIM bearer before running this.",
    );
  }
  try {
    const res = await fetch(`https://${env.apiHost}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(45_000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (err) {
    // A network failure is not evidence of absence — say so rather than
    // recording a 404 that was never returned.
    return { status: `unreachable (${String(err).split("\n")[0]})`, body: "" };
  }
}

const { context } = await attach();
const page = await context.newPage();
/*
 * Tall viewport. The create-operation form runs past the fold at 950px, and
 * Playwright refuses a click on an element outside it — reported as "Element is
 * outside of the viewport", which reads like a selector problem rather than a
 * window-size one.
 */
await page.setViewportSize({ width: 1500, height: 1300 });

try {
  await page.goto(OPS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4000);
  if (/\/login|\/signin/i.test(page.url())) {
    throw new Error("bounced to sign-in — the browser's session has expired; sign in again in the open window");
  }

  /*
   * Already registered? Read the list ONCE and skip those, so a re-run after a
   * partial failure does not create duplicates at the same path.
   *
   * Matched as a WHOLE LINE, not with `includes`. Every path here is a prefix
   * of another one — `/orders` sits inside `/orders-sync`, `/invoice`
   * inside nothing today but `/invoice-v2` tomorrow — and a substring test
   * would report the longer one as already registered and skip it for ever.
   */
  const existingPaths = new Set(
    // An ARRAY across the CDP boundary. A Set returned from page.evaluate is
    // serialised as `{}` — no error, no entries, and `.has` is not a function
    // only because something later calls it. Returning one silently reported
    // every operation as missing.
    await page.evaluate(() =>
      document.body.innerText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\/[a-z0-9/_-]+$/i.test(l)),
    ),
  );
  console.log(`  ${existingPaths.size} operation path(s) already registered`);

  for (const item of plan) {
    if (existingPaths.has(item.path)) {
      results.push({ ...item, status: "already registered" });
      console.log(`  = ${item.key.padEnd(20)} ${item.path} already exists`);
      continue;
    }
    if (dryRun) {
      results.push({ ...item, status: "would register" });
      console.log(`  · ${item.key.padEnd(20)} would register POST ${item.path}`);
      continue;
    }

    /*
     * Per-item, so one failure is one line rather than the end of the run. The
     * first version let an exception escape to the outer finally, which wrote an
     * empty result file and printed "0 handled" under a line saying the
     * operation had been created — the worst of both, a silent failure that
     * reads as success.
     */
    try {
      console.log(`  + ${item.key.padEnd(20)} POST ${item.path}`);
      await page.goto(OPS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "New operation", exact: true }).click();
      await page.waitForTimeout(2000);

      /*
       * Availability first — it is the one that is silently wrong if forgotten.
       *
       * Clicked from the page's own JS. The visible control is a styled toggle
       * whose real checkbox is parked off-screen by CSS, so Playwright reports
       * "Element is outside of the viewport" and even `force: true` refuses —
       * an error that reads as a selector or window-size problem and is neither.
       * `checked` is read back rather than the click being trusted.
       */
      const enabled = await page.evaluate(() => {
        /*
         * By ID. The aria-label is the toggle's CURRENT state ("Disabled"), so
         * selecting on it finds the control only while it is off — and returns
         * "no toggle found" the moment the form ever renders it already on.
         * `#apiAvailabilityToggle` is what the element is, not how it happens
         * to be set.
         */
        const el = document.querySelector("#apiAvailabilityToggle");
        if (!el) return "no toggle found";
        if (!el.checked) el.click();
        return el.checked;
      });
      if (enabled !== true) {
        throw new Error(`could not enable API availability (${enabled}) — the operation would be registered and inert`);
      }
      await page.waitForTimeout(600);

      await page.getByText("Select workflow").click();
      await page.waitForTimeout(1800);
      /*
       * Options are chosen in page JS for the same reason as the toggle: the
       * dropdown is a virtualised list and Playwright's click times out waiting
       * for an option to be stably clickable. Matching on exact text and
       * clicking the leaf keeps it precise — a paraphrased or partial match
       * would silently pick the wrong workflow, which is the one mistake here
       * that produces a working endpoint pointed at the wrong thing.
       */
      const picked = await page.evaluate((wanted) => {
        /*
         * THE OPTION IS THE ONE INSIDE role="option". Nothing else.
         *
         * This used to select on geometry — visible, non-empty, and below y=380
         * — because the same workflow names appear in a hidden nav list. That
         * guard does not hold. The nav renders TWICE, parked at x=-260 with
         * `offsetParent` set and a real height, and its second copy sits at
         * y=693, comfortably past the 380 line. So the filter matched an <a>
         * in the nav, the click NAVIGATED AWAY from the create form, and the
         * next line filled a form that no longer existed — surfacing as
         * "locator.fill: Timeout 30000ms exceeded" on a field the recon script
         * could plainly see. Two of the six registrations failed that way and a
         * third saved a half-bound form that answered 404.
         *
         * `role="option"` is what the dropdown actually marks its choices with,
         * so it distinguishes a choice from a link by MEANING rather than by
         * where it happens to be painted.
         */
        const options = [...document.querySelectorAll('[role="option"]')].filter(
          (o) => (o.textContent || "").trim() === wanted,
        );
        if (options.length !== 1) return { ok: false, count: options.length };
        options[0].click();
        return { ok: true, count: 1 };
      }, item.workflowName);
      if (!picked.ok) {
        throw new Error(
          `workflow "${item.workflowName}" matched ${picked.count} dropdown options (expected exactly 1) — ` +
            `either it is not offered, or the workflowName in your tray-console.config.mjs is not what the dropdown shows`,
        );
      }
      await page.waitForTimeout(1500);

      // Read the selection back. A click that missed leaves "Select workflow"
      // showing, and everything after it would fill a form bound to nothing.
      const stuck = await page.evaluate(() => !document.body.innerText.includes("Select workflow"));
      if (!stuck) throw new Error("the workflow dropdown still reads 'Select workflow' — the option click did not take");

      await page.getByPlaceholder("Operation name").fill(operationName(item));
      await page.getByPlaceholder("A description of the operation").fill(
        `${item.key}: migrated from a public webhook so the credential stops appearing in execution logs.`,
      );

      await page.getByText("Select method").click();
      await page.waitForTimeout(1500);
      const gotMethod = await page.evaluate(() => {
        // role="option" here too, for the same reason as the workflow list —
        // "POST" is short enough to appear in plenty of unrelated places.
        const opts = [...document.querySelectorAll('[role="option"]')].filter(
          (o) => (o.textContent || "").trim() === "POST",
        );
        if (opts.length !== 1) return false;
        opts[0].click();
        return true;
      });
      if (!gotMethod) throw new Error("POST not offered in the method dropdown");
      await page.waitForTimeout(1000);

      await page.getByPlaceholder(/Enter an operation path/).fill(item.path);
      await page.waitForTimeout(500);

      const save = page.getByRole("button", { name: "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      await save.click();
      await page.waitForTimeout(3500);

      /*
       * THE CLICK IS NOT THE EVIDENCE. A save that failed validation leaves the
       * dialog open with a message the script never reads, and the previous
       * version of this file recorded "registered" for three operations that
       * did not exist afterwards. So the claim is checked against the two places
       * it would have to be true: the list, and the endpoint itself.
       */
      const listed = await page.evaluate((path) => {
        const lines = document.body.innerText.split("\n").map((l) => l.trim());
        return lines.includes(path);
      }, item.path);

      const probe = await probeEndpoint(item.path);
      if (!listed || probe.status === 404) {
        throw new Error(
          `save did not take — operations list ${listed ? "shows" : "does NOT show"} ${item.path}, ` +
            `endpoint answered ${probe.status}${probe.status === 404 ? " (not registered)" : ""}`,
        );
      }
      console.log(`    verified: listed, endpoint answered ${probe.status}`);
      results.push({ ...item, status: "registered", listed, httpStatus: probe.status });
    } catch (err) {
      results.push({ ...item, status: "FAILED", error: String(err).split("\n")[0] });
      console.log(`  ! ${item.key.padEnd(20)} ${String(err).split("\n")[0].slice(0, 110)}`);
      continue;
    }
  }
} catch (err) {
  /*
   * The run itself failed, as opposed to one item failing. This used to fall
   * straight through to the `finally` below, which printed a summary and exited
   * ZERO — so a script that never reached the first operation reported
   * "0 handled" under a success message and returned a passing exit code. The
   * same fail-open shape this file warns about everywhere else, in the file
   * itself.
   */
  fatal = err;
} finally {
  try { await page.close(); } catch { /* leave the browser alone */ }
  writeFileSync("/tmp/register-operations.json", JSON.stringify(results, null, 2));
  if (fatal) {
    console.error(`\n  RUN FAILED before finishing: ${String(fatal).split("\n")[0]}`);
    console.error(`  ${results.length} item(s) handled before the failure.\n`);
  } else {
    console.log(`\n  ${results.length} handled — detail in /tmp/register-operations.json`);
    const bad = results.filter((r) => r.status === "FAILED");
    if (bad.length) console.log(`  ${bad.length} FAILED — see the file.`);
  }
  // process.exit, never browser.close(): the browser is the user's.
  process.exit(fatal || results.some((r) => r.status === "FAILED") ? 1 : 0);
}
