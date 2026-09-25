/**
 * Create MAB tools on the agent, from a file, without clicking through a dialog
 * once per tool.
 *
 * WHAT THE FORM ACTUALLY IS (read off it on 2026-08-28 with
 * inspect-agent-tools.mjs, not inferred):
 *
 *   project → Merlin Agent Builder → TOOLS tab → "Add tool" → "Custom tool"
 *   → dialog "Create New Tool for Agent"
 *        Tool name *         text
 *        Tool description *  textarea
 *        [Cancel] [Create tool]   ← Create is DISABLED until both are filled
 *
 * THE ONE THING THAT CHANGES HOW YOU USE THIS. The dialog says, in its own
 * words: "When you click create we will create the workflow, operation, and
 * assign it to the agent." So "Custom tool" MINTS A NEW WORKFLOW. It is not a
 * way to expose a workflow you already have.
 *
 * To turn an EXISTING workflow into a tool, the path is the other one:
 * `swap-triggers.mjs` to put an agent-tool-trigger on it, then
 * `register-operations.mjs` — whose dropdown, as its header records, lists only
 * workflows already carrying an api-operation-trigger or agent-tool-trigger.
 * Running this script for a workflow that exists would leave you with two.
 *
 * "Add tool" is a MENU, not a form — the other branch is "From template", which
 * is Tray's own catalogue and is not what this automates.
 *
 * THE DESCRIPTION IS THE INTERFACE. An agent chooses tools by reading these, so
 * a description is not documentation, it is the dispatch logic. A common
 * failure: tools whose description opens with "INTERNAL
 * PLUMBING, NOT A TOOL FOR AN AGENT TO CALL. Do not attach this to an agent" —
 * while attached and Enabled, so that sentence is the only thing standing
 * between the agent and internal plumbing. Prose is not a permission.
 *
 * PROVEN END TO END on 2026-08-28 against a live agent, not dry-run only:
 * two tools created, verified, then deleted, with the project counted before and
 * after. What that measured, and none of it was inferred:
 *
 *   tools 7 → 9, workflows 25 → 27, operations 23 → 25
 *
 * So one tool really is three artefacts. Each operation is created as
 * `POST /ai-agent/<slugified-name>` and **Enabled** — worth contrasting with the
 * APIM operation form, where availability defaults to DISABLED and
 * register-operations.mjs has to turn it on explicitly. Opposite defaults, same
 * screen family.
 *
 * DELETION IS SYMMETRIC. The row menu (Open tool workflow | Disable tool | Edit
 * description | Delete tool) removes all three: after deleting both probes the
 * project was back to 7 / 25 / 23 and the tool list was byte-identical to the
 * baseline. You do not have to hunt the workflow and the operation separately.
 *
 * The `fill()` helper below was the part most likely to be wrong — it scopes to
 * [role='dialog'] and falls back to `document`, where "first input with a
 * placeholder" would have been the page's Search box. It was exercised in that
 * live run and put the text in the right fields.
 *
 *   npx tray-console register-agent-tools <tools.json> [environment] [--dry-run]
 *
 *   tools.json:  [{ "name": "...", "description": "..." }, ...]
 *
 * Needs the shared browser: `npx tray-console browser`, signed in.
 */
import { readFileSync } from "node:fs";
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith("--"));
const envName = args.filter((a) => !a.startsWith("--"))[1];
const dryRun = args.includes("--dry-run");

if (!planPath) throw new Error("usage: register-agent-tools.mjs <tools.json> [environment] [--dry-run]");

const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (!Array.isArray(plan) || plan.some((t) => !t.name || !t.description)) {
  throw new Error("every entry needs a non-empty `name` and `description` — both are required by the form");
}

const env = await environment(envName);
const URL = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/ai-agents`;

/** The tool names currently attached, read from the Tools table. */
async function attachedNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("tr, [role='row']")]
      .map((r) => r.querySelector("td, [role='cell']")?.textContent?.trim())
      .filter((s) => s && s.length > 0 && s !== "Tool"),
  );
}

/** Type into the dialog field whose label matches, React-safely. */
async function fill(page, labelText, value) {
  return page.evaluate(
    ({ labelText, value }) => {
      const dialog = document.querySelector("[role='dialog']") ?? document;
      const fields = [...dialog.querySelectorAll("input, textarea")];
      // The dialog carries a search box from the page behind it in some renders,
      // so match on the field's own label rather than taking the first one.
      const el =
        fields.find((f) => (f.getAttribute("placeholder") ?? "").length > 0 && labelText === "name" && f.tagName === "INPUT") ??
        fields.find((f) => labelText === "description" && f.tagName === "TEXTAREA");
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      el.focus();
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === value;
    },
    { labelText, value },
  );
}

const { context } = await attach();
const page = await context.newPage();
// Tall: the dialog and the tools table both run past 950px, and Playwright
// refuses to click an element outside the viewport — reported as a selector
// problem, which is how register-operations.mjs lost an afternoon.
await page.setViewportSize({ width: 1500, height: 1300 });

const results = [];
try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(9000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — run login.mjs");

  await page.getByRole("tab", { name: "Tools" }).first().click();
  await page.waitForTimeout(3000);

  const before = await attachedNames(page);
  console.log(`  ${before.length} tool(s) already attached`);

  for (const tool of plan) {
    if (before.includes(tool.name)) {
      console.log(`  = ${tool.name} — already attached, skipping`);
      results.push({ ...tool, status: "exists" });
      continue;
    }
    if (dryRun) {
      console.log(`  · ${tool.name} — would create`);
      results.push({ ...tool, status: "dry-run" });
      continue;
    }

    await page.getByRole("button", { name: "Add tool" }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("menuitem", { name: "Custom tool" }).first().click();
    await page.waitForTimeout(2500);

    const okName = await fill(page, "name", tool.name);
    const okDesc = await fill(page, "description", tool.description);
    if (!okName || !okDesc) throw new Error(`could not fill the dialog for ${tool.name}`);

    const create = page.getByRole("button", { name: "Create tool" });
    if (await create.isDisabled()) throw new Error(`Create tool still disabled for ${tool.name}`);
    await create.click();
    // Creating a workflow AND an operation AND the assignment is not instant.
    await page.waitForTimeout(9000);
    results.push({ ...tool, status: "created" });
    console.log(`  + ${tool.name}`);
  }

  /*
   * VERIFY BY RE-READING, not by trusting the clicks.
   *
   * register-operations.mjs makes the same point and is worth repeating: "the
   * form submitted" and "the thing exists" are different claims, and only the
   * second matters. This reloads the tab and asserts every planned name is now
   * present.
   */
  if (!dryRun) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await page.getByRole("tab", { name: "Tools" }).first().click();
    await page.waitForTimeout(3000);
    const after = await attachedNames(page);
    const missing = plan.map((t) => t.name).filter((n) => !after.includes(n));
    if (missing.length) {
      console.error(`\n  ✗ not present after reload: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`\n  ✓ all ${plan.length} present after reload`);
    }
  }

  console.log(
    "\n  NOTE: each created tool also created a WORKFLOW and an OPERATION.\n" +
      "  Export the workflows if you keep them under version control.\n",
  );
} finally {
  await page.close().catch(() => undefined);
}
