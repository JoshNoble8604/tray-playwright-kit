/**
 * Read the project's registered operations. READ-ONLY.
 *
 * Separated from the registrar because "what exists" is a question worth asking
 * on its own — before registering anything, and again after — and because the
 * registrar's own account of what it created is exactly the thing that cannot
 * be trusted.
 *
 *   npx tray-console list-operations [environment]
 */
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const env = await environment(process.argv[2]);
const OPS_URL = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/operations`;

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });
try {
  await page.goto(OPS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(5000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — session expired");

  const rows = await page.evaluate(() => {
    const text = document.body.innerText;
    // Operation paths are the only tokens that start with a slash and are not
    // URLs; reading them off the rendered text avoids depending on a DOM
    // structure that has already changed once.
    const paths = [...new Set((text.match(/^\/[a-z0-9-]+$/gim) || []).map((s) => s.trim()))];
    return { paths, text };
  });
  console.log(`\n  ${rows.paths.length} operation paths on the page:`);
  for (const p of rows.paths.sort()) console.log(`    ${p}`);
  console.log("\n--- page text ---\n" + rows.text.slice(0, 4000));
} finally {
  await page.close();
  process.exit(0);
}
