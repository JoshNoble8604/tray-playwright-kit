/**
 * Look at the Merlin Agent Builder's TOOLS surface and report what it wants.
 *
 * READ-ONLY. It opens the page, screenshots it, and dumps every control it can
 * see. Nothing is clicked into a saved state, nothing is submitted.
 *
 * WHY THIS EXISTS BEFORE A REGISTRAR. `register-operations.mjs` carries a header
 * describing the operation form field by field, "read off it on 2026-08-26, not
 * inferred" — and it says so because the two facts that mattered were both ones
 * a reasonable person would have guessed wrong: the workflow dropdown only lists
 * workflows that ALREADY carry an api-operation-trigger or agent-tool-trigger,
 * and API availability DEFAULTS TO DISABLED. Guessing either would have produced
 * operations that exist, look registered, and answer nothing.
 *
 * The MAB tools screen has not been described anywhere. Writing a script that
 * clicks through it from assumption is how you get the same class of silent
 * failure, so this reports the ground truth first and the registrar is written
 * from its output.
 *
 * WHAT WE ALREADY KNOW, and what is therefore worth confirming rather than
 * discovering:
 *
 *   · a tool is backed by a workflow carrying an `agent-tool-trigger` — the
 *     operations dropdown offered exactly those alongside api-operation-trigger,
 *     so the trigger swap almost certainly has to happen FIRST here too;
 *   · `swap-triggers.mjs` is what performs a trigger swap, and it hardcodes the
 *     API operation trigger. If tools need the same treatment it needs a
 *     parameter, not a copy.
 *
 * The open questions this is meant to settle:
 *
 *   1. is a tool created on the agent (an "Add tool" affordance in /ai-agents)
 *      or registered project-side like an operation?
 *   2. what does the form ask for beyond a workflow — name, description, an
 *      input schema, an enable toggle?
 *   3. is there an availability/enabled default that is off, as with operations?
 *   4. does the workflow dropdown list only agent-tool-trigger workflows?
 *
 *   npx tray-console inspect-agent-tools [environment]
 *
 * Needs the logged-in browser: `npx tray-console login` first.
 */
import { writeFileSync } from "node:fs";
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const OUT = process.env.OUT_DIR ?? "/tmp";
const env = await environment(process.argv[2]);
const AGENTS_URL = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/ai-agents`;

/** Everything interactive on the page, with enough context to identify it. */
function describeControls() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) =>
    (el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      el.textContent ||
      "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);

  const out = { buttons: [], inputs: [], selects: [], toggles: [], options: [], headings: [] };
  for (const el of document.querySelectorAll("button, [role='button']")) {
    if (vis(el)) out.buttons.push(label(el));
  }
  for (const el of document.querySelectorAll("input, textarea")) {
    if (!vis(el)) continue;
    out.inputs.push({ type: el.getAttribute("type") ?? el.tagName.toLowerCase(), label: label(el) });
    // A checkbox or switch is where a default-off "enabled" hides.
    if (el.type === "checkbox" || el.getAttribute("role") === "switch") {
      out.toggles.push({ label: label(el), checked: el.checked });
    }
  }
  for (const el of document.querySelectorAll("[role='switch'], [role='checkbox']")) {
    if (vis(el)) out.toggles.push({ label: label(el), checked: el.getAttribute("aria-checked") });
  }
  for (const el of document.querySelectorAll("select, [role='combobox'], [role='listbox']")) {
    if (vis(el)) out.selects.push(label(el));
  }
  // Only meaningful once a dropdown is open; captured anyway so a run that
  // happens to have one open is not wasted.
  // menuitem as well as option: "Add tool" opens a MENU (From template |
  // Custom tool), not a form, and a dumper that only knew about role=option
  // reported the second stage as identical to the first.
  for (const el of document.querySelectorAll("[role='option'], [role='menuitem']")) {
    if (vis(el)) out.options.push(label(el));
  }
  for (const el of document.querySelectorAll("h1, h2, h3, h4, [role='heading']")) {
    if (vis(el)) out.headings.push(label(el));
  }
  return out;
}

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });

try {
  await page.goto(AGENTS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(9000);
  if (/\/login|\/signin/i.test(page.url())) {
    throw new Error("bounced to sign-in — run login.mjs, the session has expired");
  }

  const report = { url: page.url(), stages: {} };

  report.stages.agentsLanding = await page.evaluate(describeControls);
  await page.screenshot({ path: `${OUT}/mab-1-agents.png`, fullPage: true });

  /*
   * Look for the affordance that adds a tool, WITHOUT committing to a name.
   * "Add tool", "New tool", "Tools" tab — report which of them exist rather than
   * assuming one, because the whole point is that nobody has described this
   * screen.
   */
  /*
   * TWO STEPS, in order, because the first run proved they are nested.
   *
   * "Add tool" does not exist on the landing page — the probe reported 0 for it
   * and 2 for "Tools". Tools is a TAB (Agent details | Data sources | Tools |
   * Interaction channels | Test | Logs), and the Add tool button only renders
   * once that tab is open. A single flat pass over candidate names finds the tab
   * and stops, which is what the first version did.
   */
  const steps = [
    { name: "Tools", role: "tab" },
    { name: "Add tool", role: "button" },
    // Add tool is a menu, not a form. "Custom tool" is the branch that binds a
    // workflow; "From template" is Tray's own catalogue.
    { name: "Custom tool", role: "menuitem" },
  ];
  report.affordances = {};
  for (const { name, role } of steps) {
    const loc =
      role === "tab"
        ? page.getByRole("tab", { name })
        : role === "menuitem"
          ? page.getByRole("menuitem", { name })
          : page.getByRole("button", { name });
    const fallback = page.getByText(name, { exact: false });
    const target = (await loc.count()) ? loc : fallback;
    report.affordances[name] = await target.count();
    if (!(await target.count())) {
      report.stages[`missing:${name}`] = "not found — the UI has moved";
      break;
    }
    await target.first().click().catch(() => undefined);
    await page.waitForTimeout(4000);
    report.stages[`after:${name}`] = await page.evaluate(describeControls);
    await page.screenshot({ path: `${OUT}/mab-${name.replace(/\W+/g, "-")}.png`, fullPage: true });
  }

  /* The attached tools, with the descriptions the agent actually chooses on. */
  report.attachedTools = await page.evaluate(() =>
    [...document.querySelectorAll("tr, [role='row']")]
      .map((r) => r.textContent.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 20 && s.length < 400),
  );

  writeFileSync(`${OUT}/mab-tools-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n  report:      ${OUT}/mab-tools-report.json`);
  console.log(`  screenshots: ${OUT}/mab-1-agents.png (+ mab-2-*.png)\n`);
  console.log("  affordances found:");
  for (const [k, n] of Object.entries(report.affordances)) {
    if (n > 0) console.log(`    ${k}: ${n}`);
  }
  console.log("\n  Nothing was saved. Send the report and screenshots back to write the registrar.\n");
} finally {
  await page.close().catch(() => undefined);
}
