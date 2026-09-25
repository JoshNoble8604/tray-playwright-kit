/**
 * One long-lived browser that stays open, and how other scripts attach to it.
 *
 * THE PROBLEM THIS SOLVES, which cost three sign-ins. A persistent profile can
 * only be held by ONE process, so every script that wanted the browser had to
 * take the profile — which meant closing whatever window was already using it.
 * Twice that window was the one somebody had just signed into.
 *
 * So the browser is launched ONCE, with a remote debugging port, and stays open.
 * Everything else CONNECTS to it over CDP instead of launching its own. Nothing
 * ever needs to close a window somebody is using, and a session lives as long as
 * the window does.
 *
 *   npx tray-console browser     → opens it; sign in; LEAVE IT OPEN
 *   (other scripts call attach() and reuse that same browser)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE = join(homedir(), ".config", "tray", "ui-profile");
export const CDP_PORT = 9222;
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/**
 * The already-running browser. Never launches one — a script that silently
 * started a second browser would be signed out and the reason would not be
 * obvious.
 */
export async function attach() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    if (!context) throw new Error("connected, but the browser has no context");
    return { browser, context, page: context.pages()[0] ?? (await context.newPage()) };
  } catch (err) {
    throw new Error(
      `Could not attach to the browser on ${CDP_URL}.\n` +
        `Start it with:  npx tray-console browser\n` +
        `and sign in to Tray. Leave the window OPEN.\n\n(${String(err).split("\n")[0]})`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(PROFILE, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1500, height: 950 },
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  /*
   * Tray's normal sign-in: app.tray.io sends a signed-out visitor to
   * id.tray.ai/login (email + password, Google, or the company's SSO).
   *
   * Accounts that only sign in through an identity provider's dashboard set
   * TRAY_LOGIN_URL to start there instead, e.g.
   *   TRAY_LOGIN_URL=https://<your-idp>/ npx tray-console browser
   */
  const loginUrl = process.env.TRAY_LOGIN_URL ?? "https://app.tray.io/";
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  console.log(`\n  Browser open, debugging on ${CDP_URL}`);
  console.log(`  Sign in to Tray in this window (${new URL(loginUrl).host}).`);
  console.log("  LEAVE THIS WINDOW OPEN. Other scripts attach to this same browser.\n");

  await context.waitForEvent("close", { timeout: 0 });
  console.log("  Window closed.\n");
}
