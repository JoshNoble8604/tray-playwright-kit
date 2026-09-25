/**
 * Walks tray.ai → Helix solutions → the product demo, the way a visitor would.
 *
 * Four clicks, and TWO of them are nav dropdowns rather than page tabs — which
 * is the thing worth knowing before editing this. "The Platform tab on the
 * solutions page" is a header menu button, not a tab strip on the page: the
 * solutions page has no `role="tab"` anywhere on it, and "See Helix in action"
 * does not exist in the page body at all. It only appears once the Platform menu
 * is open. Read off the live pages, not inferred.
 *
 * Every step asserts what it LANDED ON rather than that the click happened. A
 * dropdown that silently fails to open leaves the next click looking for an
 * element that is present-but-hidden, and the failure then reads as a selector
 * problem three steps away from the actual cause.
 */
export const meta = {
  description: "Clicks tray.ai Products → What you can build with Helix → Platform → See Helix in action, and reports each landing.",
  timeoutMs: 120_000,
};

const START = "https://tray.ai/";
const SOLUTIONS_HOST = "helix.tray.ai";
const DEMO_PATH = "/resources/product-demo/";

/**
 * Opens a header menu and PROVES it is open, by waiting for something only the
 * open menu contains.
 *
 * WHY THIS IS NOT JUST `button.click()`. These menus also open on HOVER, and
 * Playwright moves the mouse onto an element before clicking it. Run fast and
 * the click lands before the hover handler has opened anything, so the click is
 * what opens it. Run slowly — headed, or with slowMo, or on a loaded machine —
 * and the hover opens it first, so the click TOGGLES IT SHUT. Measured: the
 * identical walk passed twice headless and then failed at this exact step with
 * `slowMo: 450`, and the failure screenshot showed the solutions page with
 * Platform highlighted and no menu.
 *
 * A fixed `hover()` instead of `click()` would break the fast case the same way
 * round. So neither gesture is trusted: toggle until the probe is visible.
 */
async function openMenu(button, probe, log, label) {
  await button.waitFor({ state: "visible" });
  // Escalating waits, short first. A menu that opens at all opens in about 50ms
  // (measured), so the FIRST probe is only long enough to cover a slow frame —
  // a generous timeout here is pure dead air on the toggle-shut path, which is
  // the common one when running slowly. A flat 5s made the walk 5s slower every
  // time the hover beat the click; 1.2s costs a fifth of that and still leaves
  // 2.5s and 5s behind it for a genuinely sluggish page.
  // CLICK, RE-CLICK, RE-CLICK — with escalating patience. Two other approaches
  // were measured and both are worse:
  //
  //   hover-first   median 17.2s, 6 failed gestures in 3 runs. Hover does not
  //                 open these menus at all, so it is 1.2s of dead air per menu.
  //   flat 5s wait  5s of dead air on every retry; ~5s slower per run.
  //
  // Which also corrects the first diagnosis. The failing first click is not a
  // hover opening the menu and the click shutting it — it is the page not being
  // INTERACTIVE yet. The header renders before its handlers attach, so the first
  // click lands on a button that is not listening, and the retry is really
  // waiting for hydration. That is why a short first wait then a longer one is
  // the right shape: the second click almost always takes.
  const waits = [1_200, 2_500, 5_000];
  for (const [i, timeout] of waits.entries()) {
    if (await probe.isVisible().catch(() => false)) {
      log(`${label} menu is open`);
      return;
    }
    await button.click();
    try {
      await probe.waitFor({ state: "visible", timeout });
      log(`${label} menu opened${i > 0 ? ` (attempt ${i + 1})` : ""}`);
      return;
    } catch {
      log(`${label} menu did not open on attempt ${i + 1} — clicking again`);
    }
  }
  throw new Error(`${label} menu never opened after ${waits.length} attempts`);
}

export async function run({ page, args, log, artifact }) {
  const shots = args.screenshots !== false;
  const steps = [];
  const shoot = async (name) => {
    if (!shots) return;
    artifact(`${name}.png`, await page.screenshot({ fullPage: false }));
  };

  log(`opening ${START}`);
  await page.goto(START, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // The header hydrates after DOMContentLoaded; waiting for the button itself is
  // the honest wait, rather than a sleep that is too short on a slow day.
  const products = page.getByRole("button", { name: "Products", exact: true });
  await products.waitFor({ state: "visible" });
  steps.push({ step: "load", url: page.url(), title: await page.title() });
  await shoot("1-tray-home");

  log("opening the Products navigation");
  const buildLink = page.getByRole("link", { name: /What you can build with Helix/i });
  await openMenu(products, buildLink, log, "Products");
  steps.push({ step: "products-menu", expanded: true });
  await shoot("2-products-open");

  log("clicking 'What you can build with Helix'");
  const href = await buildLink.getAttribute("href");
  await Promise.all([
    page.waitForURL(new RegExp(`^https://${SOLUTIONS_HOST.replace(".", "\\.")}/solutions`), { timeout: 60_000 }),
    buildLink.click(),
  ]);
  steps.push({ step: "solutions", href, url: page.url(), title: await page.title() });
  await shoot("3-solutions");

  log("opening the Platform navigation");
  const platform = page.getByRole("button", { name: "Platform", exact: true });
  // The demo link is the probe: it does not exist in the solutions page body at
  // all, only inside the open menu, so its visibility IS the menu being open.
  const demoLink = page.getByRole("link", { name: /See Helix in action/i });
  await openMenu(platform, demoLink, log, "Platform");
  steps.push({ step: "platform-menu", demo_href: await demoLink.getAttribute("href") });
  await shoot("4-platform-open");

  await Promise.all([
    page.waitForURL((u) => u.pathname.startsWith(DEMO_PATH), { timeout: 60_000 }),
    demoLink.click(),
  ]);
  const finalUrl = page.url();
  const finalTitle = await page.title();
  steps.push({ step: "demo", url: finalUrl, title: finalTitle });
  await shoot("5-demo");

  // The outcome check. Without it, a site that redirected the demo link to the
  // homepage would return a successful walk that went nowhere.
  if (!new URL(finalUrl).pathname.startsWith(DEMO_PATH)) {
    throw new Error(`Expected to land on ${DEMO_PATH}, ended on ${finalUrl}`);
  }

  log(`landed on ${finalUrl}`);
  return { final_url: finalUrl, final_title: finalTitle, steps };
}
