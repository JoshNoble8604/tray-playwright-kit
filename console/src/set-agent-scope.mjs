/**
 * Push the committed agent prompt into the live Merlin agent.
 *
 * Keep the agent's prompt file under version control and push it from there,
 * rather than pasting it into the agent. Pasting by
 * hand is how the two drift, and the drift is invisible — nothing compares them,
 * and the agent is the only one of the two that anybody talks to.
 *
 * Path: project → Merlin Agent Builder → Agent details → "Open in Editor" beside
 * Agent scope → the editor's textarea → Save.
 *
 *   npx tray-console set-agent-scope <file>
 *
 * The text comes from a FILE, not an argument: this is markdown with quotes,
 * em dashes and backticks in it, and a shell rewrites exactly those.
 *
 * ALWAYS read it back — the editor showing the right text is not the same claim
 * as the agent having saved it.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const [filePath] = process.argv.slice(2);
if (!filePath) throw new Error("usage: set-agent-scope.mjs <file>");
const prompt = readFileSync(filePath, "utf8");
const env = await environment(process.env.TRAY_ENV);
console.log(`  ${filePath}: ${prompt.length} bytes, sha256 ${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`);

const { context } = await attach();
const page = await context.newPage();
await page.setViewportSize({ width: 1500, height: 1300 });
try {
  await page.goto(`https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/ai-agents`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(9000);
  if (/\/login|\/signin/i.test(page.url())) throw new Error("bounced to sign-in — the session has expired");

  const opener = page.getByText("Open in Editor", { exact: true });
  if (!(await opener.count())) throw new Error("no 'Open in Editor' beside Agent scope");
  await opener.first().click();
  await page.waitForTimeout(4000);

  const wrote = await page.evaluate((text) => {
    // The scope editor is the tallest textarea on the page; the dialog also
    // carries short single-line fields.
    const el = [...document.querySelectorAll("textarea")]
      .map((t) => ({ t, r: t.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 200 && r.height > 60)
      .sort((a, z) => z.r.height - a.r.height)[0]?.t;
    if (!el) return null;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value.length;
  }, prompt);
  if (!wrote) throw new Error("could not find the agent scope editor");
  console.log(`  editor now holds ${wrote} bytes`);

  const save = page.getByRole("button", { name: "Save", exact: true });
  if (!(await save.count())) throw new Error("no Save button in the scope editor");
  await save.first().click();
  await page.waitForTimeout(4000);
  console.log("  saved — VERIFY by re-reading the agent's system_prompt.");
} finally {
  await page.close();
  process.exit(0);
}
