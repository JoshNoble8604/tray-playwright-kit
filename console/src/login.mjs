/**
 * Open a browser whose login STAYS logged in.
 *
 * WHY THIS IS NOT A SESSION-CAPTURE SCRIPT ANY MORE. The first version opened a
 * fresh browser, watched for "signed in", and wrote `storageState` to a file.
 * Every part of that watching was a guess, and each guess was the same mistake —
 * inferring a positive from an absence:
 *
 *   1. "the URL no longer says /login" → passed twelve seconds in, on the login
 *      page, because Tray serves sign-in from the bare domain.
 *   2. "the cookie jar has grown past one" → passed on the reCAPTCHA, Intercom
 *      and Mixpanel cookies the LOGIN PAGE sets.
 *   3. "the URL contains /workspaces/<uuid>" → never matched, so it sat waiting
 *      while somebody had already signed in, and the process was then killed
 *      along with the browser holding a perfectly good session.
 *
 * Three sign-ins thrown away by a detector nobody needed. A persistent profile
 * has no detector: Chromium writes the cookies into `--user-data-dir` itself,
 * and every later script that opens the same directory is simply already signed
 * in. There is no moment to identify and nothing to save.
 *
 *   npx tray-console login      → sign in once, close the window
 *   (later scripts reuse the profile, headless)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE = join(homedir(), ".config", "tray", "ui-profile");
mkdirSync(PROFILE, { recursive: true });

if (import.meta.url === `file://${process.argv[1]}`) {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1500, height: 950 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(process.env.TRAY_LOGIN_URL ?? "https://app.tray.io/", { waitUntil: "domcontentloaded", timeout: 120_000 });

  console.log(`\n  Profile: ${PROFILE}`);
  console.log("  Sign in, then just CLOSE the window. Nothing needs to be detected —");
  console.log("  the profile keeps the session and the next script reuses it.\n");

  // Ends when the window is closed. No condition, nothing to get wrong.
  await context.waitForEvent("close", { timeout: 0 });
  console.log("  Window closed. Session is in the profile.\n");
}
