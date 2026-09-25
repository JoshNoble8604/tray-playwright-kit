/**
 * Attach an EXISTING authentication to a step, in the UI, because nothing else can.
 *
 * `add_workflow_steps` and `update_workflow_steps` both ACCEPT an `authUuid`
 * argument, both report success, and NEITHER applies it: a read-back shows
 * `metadata.auth_uuid: null` and the step fails at runtime with "No
 * authentication is selected for the step." Same family as the `enabled: false`
 * no-op — on this API a success message is not a change.
 *
 * TWO THINGS HAD TO BE MEASURED TO MAKE THIS WORK, both by watching the console's
 * own traffic rather than guessing:
 *
 *   1. The clickable element is the innermost <p> holding the auth's name. The
 *      row, its option wrapper and its border div all carry the same text, and
 *      clicking the wrapper's centre registers nothing.
 *   2. SELECTING THE AUTH SAVES NOTHING BY ITSELF. The console emits an
 *      "Authentication Selected" analytics event and sends NOTHING to the API —
 *      not on selection, not on closing the drawer, not on clicking the canvas.
 *      The selection sits in the builder's local state.
 *
 * So the selection is committed by making an edit the builder DOES persist in
 * the same session: the step title. That is not a trick for its own sake — a step
 * added over the API is titled `execute_sql`, and every step in these workflows
 * is supposed to read as prose, so it needed a title anyway.
 *
 * IT WILL ONLY EVER CLICK A ROW WHOSE TEXT CONTAINS THE NAME YOU PASSED, and it
 * never touches "Create new authentication". Creating a credential by accident in
 * someone else's workspace is a real hazard on this dialog — it has happened —
 * and a name check is the cheap guard against it.
 *
 *   npx tray-console set-step-auth <workflowId> <stepName> "<auth name>" "<step title>"
 */
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const [workflowId, stepName, authName, newTitle] = process.argv.slice(2);
if (!workflowId || !stepName || !authName || !newTitle) {
  throw new Error('usage: set-step-auth.mjs <workflowId> <stepName> "<auth name>" "<step title>"');
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
  await page.waitForTimeout(18_000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");

  /*
   * THE DRAWER HAS TABS: Authentication | Inputs | Output. A step whose auth is
   * REQUIRED and missing — every postgres step — opens on Authentication, so the
   * picker is right there. An http-client step's auth is optional, so it opens
   * on Inputs and the picker is not in the DOM at all until the tab is clicked.
   *
   * That is why the first version of this script attached six auths and reported
   * "the step may already have an auth" for the seventh. The message was wrong:
   * the section had simply never been revealed. Clicking the tab first makes the
   * two cases one case.
   */
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("span,button,div")].find(
      (el) =>
        el.children.length === 0 &&
        el.getBoundingClientRect().left > 1000 &&
        (el.textContent || "").trim() === "Authentication",
    );
    if (tab) tab.click();
  });
  await page.waitForTimeout(3000);

  const box = await page.evaluate(() => {
    const i = [...document.querySelectorAll("input")].find(
      (el) => (el.getAttribute("placeholder") || "").includes("Search existing authentications"),
    );
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (!box) throw new Error("no 'Search existing authentications' box — the step may already have an auth");

  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(600);
  await page.keyboard.type(authName.trim(), { delay: 25 });
  await page.waitForTimeout(3500);

  // The innermost element carrying the name — see (1) above. The guard: it must
  // name the auth asked for, and must not be the create-new control.
  const target = await page.evaluate((name) => {
    const wanted = name.trim().toLowerCase();
    const hits = [...document.querySelectorAll("p,span,div")]
      .map((el) => ({ el, r: el.getBoundingClientRect(), t: (el.textContent || "").trim() }))
      .filter(({ el, r, t }) =>
        r.left > 1000 && r.top > 340 && r.height > 12 && r.height < 40 && r.width > 100 &&
        el.children.length === 0 &&
        t.toLowerCase().includes(wanted) && !/create new authentication/i.test(t) && t.length < 80);
    if (!hits.length) return null;
    const { r, t } = hits[0];
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2), t };
  }, authName);
  if (!target) throw new Error(`no leaf element naming "${authName}" appeared — nothing was clicked`);
  console.log(`  selecting: ${target.t}`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(4000);

  // The commit — see (2). Choosing an auth marks nothing dirty, so a change the
  // builder DOES persist has to be made in the same session.
  //
  // NOT THE TITLE. After an auth is chosen the title control is found, clicked
  // and simply never becomes an input — four clicks, measured. The step
  // DESCRIPTION is a plain button that opens a textarea and does not have that
  // problem, and it is worth writing regardless: a step added over the API
  // arrives with no description at all, and these workflows are meant to be read
  // by somebody who will never open this repository.
  let filled = false;
  for (let attempt = 1; attempt <= 3 && !filled; attempt += 1) {
    // IN-PAGE el.click(), NOT page.mouse. After an auth is chosen something
    // swallows synthetic pointer events in the drawer: the title control and the
    // description control are both found at correct coordinates, clicked, and
    // neither opens. Dispatching the click on the element itself bypasses hit
    // testing altogether, which is the same class of problem as the
    // `aside.canvas-overlay` problem (see swap-triggers.mjs), arriving from the
    // other side.
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((el) => el.getBoundingClientRect().left > 1000 && /^(add|edit) description$/i.test((el.textContent || "").trim()));
      if (!b) return null;
      b.click();
      return (b.textContent || "").trim();
    });
    if (!opened) throw new Error("could not find the step description control to commit with");
    if (attempt === 1) console.log(`  committing via description ("${opened}")`);
    await page.waitForTimeout(1800);

    filled = await page.evaluate((text) => {
      const input = [...document.querySelectorAll("textarea,input")]
        .map((i) => ({ i, r: i.getBoundingClientRect() }))
        .filter(({ i, r }) => r.width > 200 && r.left > 1000 && r.top > 150 && r.top < 500 &&
                              !(i.getAttribute("placeholder") || "").includes("Search existing"))
        .sort((a, z) => a.r.top - z.r.top)[0]?.i;
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
      return true;
    }, newTitle);
    if (!filled) console.log(`  description box did not open (attempt ${attempt})`);
  }
  if (!filled) throw new Error("the description box never opened — nothing was committed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(12_000);

  console.log('  done — VERIFY with get_workflow view:"auths"; the page is not the record.');
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  await page.screenshot({ path: "/tmp/set-step-auth-failure.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
