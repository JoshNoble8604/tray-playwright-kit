/**
 * Rename a workflow step, in the UI, because nothing else can.
 *
 * `update_workflow_steps` takes properties, operation, auth and error handling —
 * but NOT `title`, and the schema is closed, so a step's human label cannot be
 * changed over the API at all. That matters more than it sounds: step titles
 * are often the business-readable surface of a workflow, so every correction to
 * the language a reviewer reads is a UI edit.
 *
 * The title is a button in the step drawer that becomes an input when clicked.
 * The drawer is opened by URL (`?steps=<name>`) rather than by hunting the node
 * on the canvas — the canvas opens scrolled away from the trigger and its nodes
 * are not reachable by Playwright's actionability checks (see swap-triggers.mjs).
 *
 *   npx tray-console set-step-title <workflowId> <stepName> "<new title>"
 */
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const [workflowId, stepName, newTitle] = process.argv.slice(2);
if (!workflowId || !stepName || !newTitle) {
  throw new Error('usage: set-step-title.mjs <workflowId> <stepName> "<new title>"');
}
const env = await environment(process.env.TRAY_ENV);

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });
try {
  await page.goto(
    `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/workflows/${workflowId}?steps=${stepName}`,
    { waitUntil: "domcontentloaded", timeout: 90_000 },
  );
  await page.waitForTimeout(15_000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");

  /** The drawer's title button: top-left of the drawer, the widest control on its row. */
  const point = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 200 && r.left > 1000 && r.top > 150 && r.top < 185)
      .sort((a, z) => z.r.width - a.r.width)[0];
    if (!b) return null;
    return { x: Math.round(b.r.left + 20), y: Math.round(b.r.top + b.r.height / 2), was: (b.el.textContent || "").trim() };
  });
  if (!point) throw new Error("could not find the step title control in the drawer");
  console.log(`  was: ${point.was}`);

  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(1200);

  // The button becomes a text input in place. Select all, replace, commit.
  const filled = await page.evaluate((title) => {
    const input = [...document.querySelectorAll("input,textarea")].find((i) => {
      const r = i.getBoundingClientRect();
      return r.width > 200 && r.left > 1000 && r.top > 150 && r.top < 195;
    });
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    ).set;
    // React tracks the value on the node; assigning through the prototype setter
    // and firing `input` is what makes it notice. A plain `.value =` is ignored.
    setter.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, newTitle);
  if (!filled) throw new Error("the title did not become an editable input when clicked");

  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  /*
   * Read back from the page, and then CHECK IT WITH get_workflow — a rendered
   * title is what the editor thinks, not what was saved.
   */
  const now = await page.evaluate(() => document.body.innerText);
  console.log(now.includes(newTitle) ? "  page shows the new title" : "  page does NOT show the new title");
  console.log("  now verify with get_workflow — the page is not the record.");
} finally {
  await page.close();
  process.exit(0);
}
