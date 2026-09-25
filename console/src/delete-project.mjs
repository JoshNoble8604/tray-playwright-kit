/**
 * Delete a Tray project, workflows and all. Irreversible.
 *
 *   tray-console delete-project <projectId> --confirm "<exact project name>"
 *   tray-console delete-project <projectId> --dry-run      # open the dialog, cancel
 *
 * WHY THE UI. The Tray MCP has no project delete. The sidebar's "Delete project"
 * does it (two dialogs, the second wants DELETE typed). --confirm must match the
 * project's name, so a wrong id cannot delete the wrong project. Verified by
 * reading the project back.
 */
import { environment } from "./config.mjs";
import { consoleSession, mouseClick, run } from "./session.mjs";

const argv = process.argv.slice(2);
const [projectId] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--confirm");
const confirm = argv.includes("--confirm") ? argv[argv.indexOf("--confirm") + 1] : null;
const dry = argv.includes("--dry-run");
if (!projectId || (!confirm && !dry)) {
  console.error('usage: tray-console delete-project <projectId> --confirm "<exact project name>" | --dry-run');
  process.exit(1);
}

const env = await environment(process.env.TRAY_ENV);
const s = await consoleSession(`https://app.tray.io/workspaces/${env.workspaceId}/projects/${projectId}/workflows`);

await run(s, async () => {
  const project = await s.api("GET", `/v2/projects/${projectId}`);
  console.log(`project: "${project.name}" (${projectId})`);
  if (project.deletedAt) return console.log(`already deleted at ${project.deletedAt}`);
  if (!dry && project.name !== confirm) throw new Error(`--confirm "${confirm}" does not match the project name — nothing deleted`);

  const p = s.page;
  const link = p.getByText(/^Delete project$/).first();
  await link.waitFor({ timeout: 30_000 });
  await mouseClick(p, link);
  const dialog = p.getByRole("dialog").last();
  await dialog.waitFor({ timeout: 15_000 });
  await p.waitForTimeout(2000); // it slides in; a click mid-animation misses
  console.log(`dialog: ${(await dialog.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);

  if (dry) {
    await mouseClick(p, dialog.getByRole("button", { name: /^Cancel$/i }));
    return console.log("--dry-run: cancelled, nothing deleted");
  }

  // Two dialogs: the first lists the workflows going with it, the second wants DELETE typed.
  await mouseClick(p, dialog.getByRole("button", { name: /^Delete$/ }));
  const typeBox = p.getByPlaceholder("Type DELETE");
  await typeBox.waitFor({ timeout: 15_000 });
  await p.waitForTimeout(1500);
  await typeBox.fill("DELETE");
  await mouseClick(p, p.getByRole("dialog").last().getByRole("button", { name: /^Delete$/ }));
  await p.waitForTimeout(5000);

  // Soft delete: the project stays readable with deletedAt set.
  const gone = await s.api("GET", `/v2/projects/${projectId}`).then((r) => Boolean(r.deletedAt), () => true);
  if (!gone) throw new Error("clicked Delete but the project still exists");
  console.log(`✓ deleted "${project.name}"`);
});
