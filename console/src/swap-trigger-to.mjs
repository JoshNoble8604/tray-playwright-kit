/**
 * Swap ONE workflow's trigger to an arbitrary type, in the UI.
 *
 * A near-copy of swap-triggers.mjs, which hardcodes "API Operation" because it
 * exists for the APIM migration. Everything below the trigger-picker click is
 * that script's hard-won canvas handling and is deliberately unchanged — the
 * coordinate work, the fit-to-view press and the hover diff all cost real time
 * to get right and must not be re-derived.
 *
 *   node src/swap-trigger-to.mjs <workflowId> "<Trigger label>" [env]
 *
 * Written to give workflows 30/31/32 a SCHEDULED trigger: all three sit on a
 * manual `noop` trigger, so none of them can replace the Helix schedule it was
 * built to replace. Until that changes nothing can be retired.
 *
 * The API cannot do this — `remove_workflow_step("trigger")` is rejected with
 * `jsonpath_step_missing` for every downstream `$.steps.trigger.*` reference.
 * The builder's "Replace trigger" can, and PRESERVES those references. Verified
 * on a reproduction carrying a real one before this script was written.
 *
 *   npx tray-console swap-triggers [env] [--only key] [--dry-run]
 *
 * AFTER this, two API edits per workflow are still required (see
 * apim-trigger-shape.mjs): the new trigger's `response.success` arrives empty
 * with additionalProperties false, and the reply step still has the webhook
 * shape. `fix-apim-steps.mjs` does both.
 *
 * THE WEBHOOK URL DIES THE MOMENT THIS RUNS. Everything the engine calls is
 * unreachable until its operation is registered and `.env` is repointed. Run it
 * with detection paused.
 */
import { writeFileSync } from "node:fs";
import { attach } from "./browser.mjs";
import { environment } from "./config.mjs";

const args = process.argv.slice(2);
const workflowId = args[0];
const triggerLabel = args[1];
if (!workflowId || !triggerLabel) {
  throw new Error('usage: swap-trigger-to.mjs <workflowId> "<Trigger label>" [env]');
}
const env = await environment(args[2]);
const dryRun = args.includes("--dry-run");
const plan = [{ key: workflowId.slice(0, 8), workflowId }];

const results = [];
const { context } = await attach();
const page = await context.newPage();
/*
 * 1300, not 950. The builder's trigger-replace panel runs past the fold at 950
 * and Playwright refuses to click an element outside the viewport — reported as
 * a selector problem, which it is not. Same reason the operations form uses it.
 */
await page.setViewportSize({ width: 1500, height: 1300 });

try {
  for (const m of plan) {
    const url = `https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/workflows/${m.workflowId}`;
    if (dryRun) { console.log(`  · ${m.key} would swap`); results.push({ ...m, status: "would swap" }); continue; }

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(15000);

      /*
       * Find the trigger NODE rather than assuming where it is.
       *
       * Fixed coordinates worked on a three-step workflow and missed on longer
       * ones: the builder opens scrolled to the BOTTOM of the canvas, so on
       * "Post package to Teams" the trigger sat off-screen above and the click
       * landed on empty space — reported as "no Replace trigger in the step
       * menu", which is the wrong diagnosis entirely.
       *
       * Every step renders its machine name as a monospace sub-label, so the one
       * reading exactly "trigger" IS the node. The "..." sits ~99px to its left
       * and exists only while the row is hovered.
       */
      /*
       * HOW THE TRIGGER STEP'S MENU IS ACTUALLY REACHED IN THIS BUILDER.
       *
       * What makes the rest of this work: the canvas
       * cannot be reached with scrollIntoViewIfNeeded, and `.hover()` on a
       * node times out because `aside.canvas-overlay` eats pointer events, so
       * raw `page.mouse` at measured coordinates is the way in.
       *
       * TWO THINGS DIFFER from older builds of the editor, and both were found
       * by probing rather than assumed:
       *
       *  · The older `button[aria-label="ellipsis-h"]` DOES NOT EXIST here.
       *    There is no such aria-label anywhere on the page. Steps render as
       *    DIV/SPAN (`StepName___`, `StepTitleButton___`), not the SVG groups
       *    with `STRONG[class*="StepTitle"]` older builds used.
       *  · The controls appear on HOVER, not on selection. Older builds did the
       *    opposite, and following that produced "no ellipsis-h
       *    appeared" on a node that was correctly selected.
       *
       * So the menu button is identified by BEHAVIOUR: it is the button that is
       * not there at rest and IS there while the node is hovered. That survives
       * both a missing aria-label and a class name like `sc-ezyqiv sc-lgwORA`,
       * which is generated and shared with unrelated toolbar buttons.
       *
       * "Fit to view" is pressed first. The builder opens scrolled to the bottom
       * AND with the leftmost column clipped, so the trigger's controls sit at a
       * NEGATIVE x (measured: title at x=72, menu button at x=-44) where no
       * click can land. Fit puts the whole graph on screen — the same node then
       * measures x=683 — and it is one button press rather than an arithmetic
       * guess about a transform.
       */
      const fitPressed = await page.evaluate(() => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const corner = [...document.querySelectorAll("button")]
          .map((b) => ({ b, r: b.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.left > w - 180 && r.top > h - 90)
          .sort((a, z) => a.r.left - z.r.left);
        // zoom-out, fit, zoom-in — fit is the middle one.
        if (corner.length < 3) return false;
        corner[1].b.click();
        return true;
      });
      if (!fitPressed) throw new Error("could not find the canvas zoom cluster to press 'fit to view'");
      await page.waitForTimeout(2500);

      const labelRect = async () =>
        page.evaluate(() => {
          const el = [...document.querySelectorAll("*")].find(
            (e) => e.children.length === 0 && (e.textContent || "").trim() === "trigger",
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
        });
      const rect = await labelRect();
      if (!rect) throw new Error("could not find the trigger node on the canvas");
      if (rect.l < 120 || rect.t < 40) {
        throw new Error(`trigger node still clipped after fit (x=${rect.l}, y=${rect.t}) — its menu would be off-canvas`);
      }

      /** Every visible button, as a position key, so hover can be diffed against rest. */
      const buttonKeys = () =>
        page.evaluate(() =>
          [...document.querySelectorAll("button")]
            .map((b) => b.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`),
        );

      const atRest = new Set(await buttonKeys());
      // The node's icon sits left of its title; hovering anywhere on the row works.
      await page.mouse.move(rect.l - 40, rect.t + rect.h / 2);
      await page.waitForTimeout(1800);
      const revealed = (await buttonKeys()).filter((k) => !atRest.has(k));

      /*
       * Of the buttons hover revealed, take the one on the trigger's own row and
       * nearest to its title. The title button is revealed too, so "revealed" on
       * its own is not enough — it must also be LEFT of the title.
       */
      const menu = revealed
        .map((k) => k.split(",").map(Number))
        .map(([l, t, w]) => ({ l, t, w }))
        .filter((b) => b.l < rect.l && Math.abs(b.t - rect.t) < 60)
        .sort((a, z) => z.l - a.l)[0];
      if (!menu) {
        throw new Error(
          `hovering the trigger revealed no menu button left of its title ` +
            `(${revealed.length} button(s) appeared) — the node may not be hoverable at this zoom`,
        );
      }

      await page.mouse.move(menu.l + 16, menu.t + 16);
      await page.waitForTimeout(600);
      await page.mouse.click(menu.l + 16, menu.t + 16);
      await page.waitForTimeout(2500);

      const replace = page.getByText("Replace trigger", { exact: true });
      if (!(await replace.count())) throw new Error("no 'Replace trigger' in the step menu");
      await replace.click();
      await page.waitForTimeout(3000);

      if (triggerLabel === "?") {
        const options = await page.evaluate(() =>
          [...document.querySelectorAll("*")]
            .filter((e) => e.children.length === 0)
            .map((e) => (e.textContent || "").trim())
            .filter((t) => t.length > 1 && t.length < 40)
            .filter((t, i, a) => a.indexOf(t) === i),
        );
        console.log("\n  PICKER OPTIONS:\n" + options.map((o) => "    " + o).join("\n"));
        results.push({ ...m, status: "recon" });
        continue;
      }
      await page.getByText(triggerLabel, { exact: true }).first().click();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.waitForTimeout(6000);

      /*
       * The URL is a weak confirmation — the builder rewrites it on selecting
       * the trigger step at all, swapped or not. The trigger's rendered title
       * is what actually changes, so both are required, and the AUTHORITATIVE
       * check is a `get_workflow` afterwards showing connector
       * `api-operation-trigger`. This script cannot make that call; do not treat
       * a "swapped" line here as the end of the check.
       */
      const titled = await page.evaluate((t) => document.body.innerText.includes(t), triggerLabel);
      const ok = /\?steps=trigger/.test(page.url()) && titled;
      results.push({ ...m, status: ok ? "swapped" : "UNCONFIRMED" });
      console.log(`  ${ok ? "+" : "?"} ${m.key.padEnd(20)} ${ok ? "swapped" : "did not confirm — check by hand"}`);
    } catch (err) {
      results.push({ ...m, status: "FAILED", error: String(err).split("\n")[0] });
      console.log(`  ! ${m.key.padEnd(20)} ${String(err).split("\n")[0].slice(0, 90)}`);
    }
  }
} finally {
  try { await page.close(); } catch { /* the browser is the user's */ }
  writeFileSync("/tmp/swap-trigger-to.json", JSON.stringify(results, null, 2));
  const done = results.filter((r) => r.status === "swapped").length;
  console.log(`\n  ${done}/${plan.length} swapped — detail in /tmp/swap-trigger-to.json\n`);
  process.exit(0);
}
