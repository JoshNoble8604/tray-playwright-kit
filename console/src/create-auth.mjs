/**
 * Create an authentication in the workspace, from scratch, through the console.
 *
 *   tray-console create-auth --service "<service>" --show            # list its fields
 *   tray-console create-auth --service "<service>" --name "<auth name>" \
 *       --field "API Key=@env:MY_KEY" --field "Base URL=https://..." [--field ...]
 *
 * A value is literal, or @env:VAR, or @file:path — secrets never go in argv.
 * OAuth services stop at the provider's consent screen: that tab is left open
 * in the tray-console browser for a human to finish.
 *
 * WHY. The MCP's create_auth_collection only hands out a link; the form itself
 * (service picker, named fields, dropdowns) has no API. Verified by finding the
 * new name on /auths afterwards.
 */
import { readFileSync } from "node:fs";
import { environment } from "./config.mjs";
import { consoleSession, mouseClick, run } from "./session.mjs";

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const service = opt("service");
const name = opt("name");
const show = argv.includes("--show");
const fields = argv
  .flatMap((a, i) => (argv[i - 1] === "--field" ? [a] : []))
  .map((f) => {
    const at = f.indexOf("=");
    if (at < 1) {
      console.error(`✖ --field wants "Label=value", got "${f}"`);
      process.exit(1);
    }
    const raw = f.slice(at + 1);
    const value = raw.startsWith("@env:") ? process.env[raw.slice(5)] : raw.startsWith("@file:") ? readFileSync(raw.slice(6), "utf8").trim() : raw;
    if (value === undefined) {
      console.error(`✖ ${raw} is not set`);
      process.exit(1);
    }
    return { label: f.slice(0, at).trim(), value, secret: raw.startsWith("@") };
  });
if (!service || (!show && !name)) {
  console.error('usage: tray-console create-auth --service "<service>" (--show | --name "<name>" [--field "Label=value"]...)');
  process.exit(1);
}

const env = await environment(process.env.TRAY_ENV);
const AUTHS = `https://app.tray.io/workspaces/${env.workspaceId}/auths`;
const s = await consoleSession(AUTHS);
const p = s.page;

/**
 * Visible inputs in the dialog, each with its label. Labels are plain text, not
 * <label>: take the widest ancestor holding only this one field, first line.
 */
const describe = (d) =>
  d.locator("input:visible, textarea:visible").evaluateAll((els) =>
    els.map((e, i) => {
      let own = e;
      for (let n = e.parentElement; n && n.querySelectorAll("input, textarea").length === 1; n = n.parentElement) own = n;
      const label = (own.innerText || "").split("\n").map((x) => x.trim()).find(Boolean)?.replace(/\s*\*$/, "") ?? "";
      return { i, label, kind: e.placeholder === "Choose an option" ? "dropdown" : e.tagName === "TEXTAREA" ? "text" : e.type, placeholder: e.placeholder };
    }),
  );

await run(s, async () => {
  await p.getByRole("button", { name: /Add authentication|New authentication/i }).first().waitFor({ timeout: 30_000 });
  await mouseClick(p, p.getByRole("button", { name: /Add authentication|New authentication/i }).first());
  await p.getByText(/^From scratch$/).first().waitFor({ timeout: 10_000 });
  await mouseClick(p, p.getByText(/^From scratch$/).first());
  // Not matched by text: the title changes to "<Service> authentication" once picked.
  const d = p.getByRole("dialog").last();
  await d.getByText(/Choose a service/).first().waitFor({ timeout: 20_000 });
  const cancel = () => mouseClick(p, d.getByRole("button", { name: /^Cancel$/ })).catch(() => p.keyboard.press("Escape"));

  // 1. Service: a dropdown with its own filter box. Exact name wins over partial.
  // The dialog animates in; a click mid-slide misses. Retry until the filter box has focus.
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(1200);
    await mouseClick(p, d.getByText(/Choose a service/).first());
    await p.waitForTimeout(800);
    if (await p.evaluate(() => document.activeElement?.tagName === "INPUT")) break;
  }
  await p.keyboard.type(service, { delay: 40 });
  await p.getByRole("option").first().waitFor({ timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(1000);
  const raw = (await p.getByRole("option").allTextContents()).map((x) => x.trim());
  const opts = [...new Set(raw)];
  const pick = opts.find((o) => o.toLowerCase() === service.toLowerCase()) ?? (opts.length === 1 ? opts[0] : null);
  if (!pick) {
    await p.keyboard.press("Escape");
    await cancel();
    throw new Error(`service "${service}" is ${opts.length ? `ambiguous: ${opts.slice(0, 12).join(", ")}` : "not found"}`);
  }
  // By position: an option's accessible name carries its icon's alt text too.
  await p.getByRole("option").nth(raw.indexOf(pick)).click();
  await p.waitForTimeout(1500);

  // 2. Name, then on to the service's own form.
  await d.getByPlaceholder(/authentication name/i).fill(name ?? `${pick} (kit --show)`);
  await mouseClick(p, d.getByRole("button", { name: /Next step/i }));
  await p.waitForTimeout(3500);
  const form = await describe(d);

  if (show) {
    console.log(`${pick} — fields:`);
    for (const f of form) console.log(`  ${(f.label || "(no label)").padEnd(34)} ${f.kind}${f.placeholder ? `  "${f.placeholder}"` : ""}`);
    const scopes = await d.locator("[role=checkbox], input[type=checkbox]").count();
    if (scopes) console.log(`  + ${scopes} scope checkboxes (OAuth service)`);
    return cancel();
  }

  for (const f of fields) {
    const hit = form.find((x) => x.label.toLowerCase() === f.label.toLowerCase());
    if (!hit) {
      await cancel();
      throw new Error(`no field "${f.label}". Fields: ${form.map((x) => x.label).filter(Boolean).join(", ")}`);
    }
    const el = d.locator("input:visible, textarea:visible").nth(hit.i);
    if (hit.kind === "dropdown") {
      await mouseClick(p, el);
      await p.waitForTimeout(1000);
      // These menus are not role=option; pick the choice by its exact text.
      const choice = p.getByText(f.value, { exact: true }).last();
      if (!(await choice.isVisible().catch(() => false))) throw new Error(`"${f.label}" has no option "${f.value}"`);
      await mouseClick(p, choice);
    } else await el.fill(f.value);
    console.log(`  ${f.label} = ${f.secret ? "(secret)" : f.value}`);
  }

  const pagesBefore = s.context.pages().length;
  await mouseClick(p, d.getByRole("button", { name: /^(Create authentication|Create|Save)$/i }).first());
  await p.waitForTimeout(6000);

  if (s.context.pages().length > pagesBefore || /accounts\.|oauth|consent|authorize/i.test(p.url())) {
    console.log("OAuth consent is open in the tray-console browser — finish it there. That tab stays open.");
    return;
  }
  await p.goto(AUTHS, { waitUntil: "domcontentloaded" });
  const listed = p.getByText(name, { exact: true });
  await listed.first().waitFor({ timeout: 20_000 }).catch(() => {});
  if (!(await listed.count())) throw new Error(`pressed Create but "${name}" is not on /auths`);
  console.log(`✓ created "${name}"`);
});
