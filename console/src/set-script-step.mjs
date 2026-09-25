/**
 * Push a committed script file into a workflow's `script` step, via the UI.
 *
 * WHY THIS IS UI WORK. `update_workflow_steps` CAN set a script step's
 * properties — but properties REPLACE rather than merge, so updating the script
 * means sending the whole file as a literal in the tool call. For a long
 * script file that is kilobytes of JavaScript retyped by hand into an argument,
 * where a single transposed character silently changes behaviour. The file on
 * disk is the reviewable artefact;
 * it should travel as bytes, not as a transcription.
 *
 * If you check that the step matches the file VERBATIM — the repo copy is the
 * one that gets reviewed — the two must be pushed together whenever either
 * changes.
 *
 * The editor is a plain <textarea>, not Monaco or CodeMirror, so React's native
 * value setter is enough (the same trick set-step-title.mjs uses; a plain
 * `.value =` is ignored).
 *
 *   npx tray-console set-script-step <workflowId> <stepName> <file>
 *
 * ALWAYS verify afterwards with `get_workflow view:"step"` and compare a hash —
 * the textarea showing the right text is not the same claim as Tray having
 * saved it.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const [workflowId, stepName, filePath] = process.argv.slice(2);
if (!workflowId || !stepName || !filePath) {
  throw new Error("usage: set-script-step.mjs <workflowId> <stepName> <file>");
}
const source = readFileSync(filePath, "utf8");
const sha = createHash("sha256").update(source).digest("hex");
const env = await environment(process.env.TRAY_ENV);

console.log(`  pushing ${filePath} (${source.length} bytes, sha256 ${sha.slice(0, 16)})`);

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });
try {
  await page.goto(
    `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/workflows/${workflowId}?steps=${stepName}`,
    { waitUntil: "domcontentloaded", timeout: 90_000 },
  );
  await page.waitForTimeout(16_000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");

  const before = await page.evaluate(() => {
    const t = [...document.querySelectorAll("textarea")].sort((a, z) => (z.value || "").length - (a.value || "").length)[0];
    return t ? t.value.length : null;
  });
  if (before === null) throw new Error("no textarea in the step drawer — is this a script step?");
  console.log(`  editor currently holds ${before} bytes`);

  const set = await page.evaluate((text) => {
    // The script body is the LONGEST textarea in the drawer; the step also has
    // short ones (description, variable names).
    const t = [...document.querySelectorAll("textarea")].sort((a, z) => (z.value || "").length - (a.value || "").length)[0];
    if (!t) return false;
    t.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, text);
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));
    t.blur();
    return t.value.length;
  }, source);
  if (!set) throw new Error("could not write into the script editor");
  console.log(`  editor now holds ${set} bytes`);

  // Blur commits; give the builder time to persist before the page is closed.
  await page.mouse.click(740, 700);
  await page.waitForTimeout(6000);
  console.log("  saved — VERIFY with get_workflow and compare the hash.");
} finally {
  await page.close();
  process.exit(0);
}
