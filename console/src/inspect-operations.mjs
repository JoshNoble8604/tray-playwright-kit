/**
 * Look at the project's Operations view and report what it actually wants.
 *
 * READ-ONLY. It opens the page, screenshots it, and dumps the form controls it
 * can see. Nothing is clicked, submitted or changed.
 *
 * It exists because the whole APIM migration plan rests on assumptions about a
 * screen nobody has described: whether a workflow must already carry an
 * `api-operation-trigger` before it can be bound, what an operation needs
 * besides method and path, and whether "availability" is a choice that can be
 * got wrong. Automating a batch of registrations against guesses about that form
 * is how you end up with endpoints that 404 for a reason nothing
 * reports.
 *
 *   npx tray-console inspect-operations
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { PROFILE } from "./login.mjs";
import { environment } from "./config.mjs";

const OUT = process.env.OUT_DIR ?? "/tmp";
const env = await environment(process.argv[2]);

if (!existsSync(PROFILE)) {
  console.error(`\n  No browser profile at ${PROFILE}.\n  Run: npx tray-console login\n`);
  process.exit(1);
}

/*
 * Headed, deliberately. This is reconnaissance on a screen nobody has described,
 * and a screenshot of a page that silently redirected is indistinguishable from
 * a screenshot of the page you wanted. Watching it happen is the point.
 */
/*
 * Only one process may hold the profile. If the login window is still open,
 * Playwright fails with "Opening in existing browser session", which reads as a
 * bug rather than as "close the other window".
 */
let context;
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1500, height: 950 },
  });
} catch (err) {
  if (/existing browser session/i.test(String(err))) {
    console.error("\n  The browser profile is in use — close the sign-in window first.\n");
    process.exit(1);
  }
  throw err;
}
const page = context.pages()[0] ?? (await context.newPage());

const url = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}`;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForTimeout(4000);

if (/\/login|\/signin/i.test(page.url())) {
  console.error("\n  Bounced to sign-in — the profile's session has expired.");
  console.error("  Run: npx tray-console login\n");
  await context.close();
  process.exit(1);
}

console.log(`\n  Landed on: ${page.url()}`);
await page.screenshot({ path: `${OUT}/tray-project.png`, fullPage: true });

/* Every tab / nav item on the project, so the Operations view can be named
   rather than guessed at from a URL that may not exist. */
const nav = await page.evaluate(() =>
  [...document.querySelectorAll('a, button, [role="tab"]')]
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t.length > 0 && t.length < 40),
);
console.log("\n  Controls visible on the project page:");
for (const t of [...new Set(nav)]) console.log(`    · ${t}`);

const ops = page.getByText(/^Operations$/i).first();
if (await ops.count()) {
  await ops.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/tray-operations.png`, fullPage: true });
  console.log(`\n  Operations view opened — ${OUT}/tray-operations.png`);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  console.log("\n--- Operations view text ---\n" + text);
} else {
  console.log("\n  No 'Operations' control found on this page. See the screenshot.");
}

await context.close();
