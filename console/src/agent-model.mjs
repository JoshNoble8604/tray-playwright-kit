/**
 * Read or change a Merlin agent's AI model — the project's "Change AI model" dialog.
 *
 *   tray-console agent-model                                            # current model
 *   tray-console agent-model --provider "AWS Bedrock"                   # its authentications
 *   tray-console agent-model --provider "AWS Bedrock" --auth "<name>"   # that auth's models
 *   tray-console agent-model --provider <p> [--auth <a>] [--model <m>] --set
 *
 * WHY THE UI. The agent API does not carry the model and nothing else sets it.
 * Without --set it always presses Cancel. With --set it presses Connect and
 * reads the model back. Custom takes a typed model id; the others pick from a list.
 * Uses the project named by TRAY_ENV; it must be an agent (accelerator) project.
 */
import { environment } from "./config.mjs";
import { consoleSession, mouseClick, run } from "./session.mjs";

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const [provider, authName, model, set] = [opt("provider"), opt("auth"), opt("model"), argv.includes("--set")];
if (set && !provider) {
  console.error("--set needs --provider (and --auth/--model unless the provider is Tray Native)");
  process.exit(1);
}

const env = await environment(process.env.TRAY_ENV);
const s = await consoleSession(`https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/ai-agents`);
const p = s.page;

const current = async () => {
  const t = await p.innerText("body");
  const m = t.match(/AI model \*([\s\S]*?)(Advanced model settings|Change AI model)/);
  return (m?.[1] ?? "?").split("\n").map((x) => x.trim()).filter(Boolean).filter((x) => !/^Tray Native model will be used|^We recommend/.test(x)).join(" · ");
};
const options = async () => [...new Set((await p.getByRole("option").allTextContents()).map((x) => x.trim()).filter(Boolean))];

await run(s, async () => {
  for (let i = 0; i < 30 && !/AI model \*[\s\S]*Change AI model/.test(await p.innerText("body")); i++) await p.waitForTimeout(1000);
  if (!/Change AI model/.test(await p.innerText("body"))) throw new Error("no agent in this project (needs an accelerator project)");
  console.log(`current: ${await current()}`);
  if (!provider) return;

  await mouseClick(p, p.getByText(/^Change AI model$/).first());
  const d = p.getByRole("dialog").filter({ hasText: "Model provider" });
  // The dialog mounts, then Cancel/Connect, then the provider list. Wait for the list.
  await d.locator("button").filter({ hasText: "Tray Native" }).first().waitFor({ timeout: 20_000 });
  const cancel = () => mouseClick(p, d.getByRole("button", { name: /^Cancel$/ }));

  const button = d.locator("button").filter({ hasText: provider });
  if (!(await button.count())) {
    const names = (await d.locator("button").allTextContents()).filter((x) => !/Cancel|Connect/.test(x));
    await cancel();
    throw new Error(`no provider "${provider}". Offered: ${names.join(", ")}`);
  }
  await mouseClick(p, button.first());
  await p.waitForTimeout(2000);

  if (!/Tray Native/.test(provider)) {
    const picker = d.getByText(/^Select an authentication$/).first();
    if (!(await picker.count())) {
      await cancel();
      throw new Error(`no authentications for ${provider} — create one first`);
    }
    await mouseClick(p, picker);
    await p.waitForTimeout(1500);
    const auths = (await options()).filter((x) => !/Create new authentication/.test(x));
    if (!authName) {
      console.log(`${provider} authentications:\n  ${auths.join("\n  ")}`);
      return cancel();
    }
    if (!auths.includes(authName)) {
      await p.keyboard.press("Escape");
      await cancel();
      throw new Error(`no authentication "${authName}". Offered: ${auths.join(", ")}`);
    }
    await p.getByRole("option", { name: authName, exact: true }).click();
    await p.waitForTimeout(3000);

    const typed = d.locator("input:visible:not([role=combobox])").last();
    if (/Custom/.test(provider)) {
      if (!model) return (console.log("Custom takes any OpenAI-compatible model id: pass --model"), cancel());
      await typed.fill(model);
    } else {
      await mouseClick(p, d.getByText(/Select a model|Authenticate to see/).first());
      await p.waitForTimeout(2500);
      const models = await options();
      if (!model) {
        console.log(`${provider} models (${models.length}):\n  ${models.join("\n  ")}`);
        await p.keyboard.press("Escape");
        return cancel();
      }
      if (!models.includes(model)) {
        await p.keyboard.press("Escape");
        await cancel();
        throw new Error(`no model "${model}" for that auth. Offered: ${models.join(", ")}`);
      }
      await p.getByRole("option", { name: model, exact: true }).click();
    }
  }

  if (!set) {
    console.log("(not saved — pass --set to connect)");
    return cancel();
  }
  const connect = d.getByRole("button", { name: /^Connect$/ });
  if (!(await connect.isEnabled())) throw new Error("Connect is disabled — the form is incomplete");
  await mouseClick(p, connect);
  await p.waitForTimeout(5000);
  // A notice about custom providers can follow Connect.
  const ack = p.getByRole("button", { name: /^(OK|Got it|Continue|Confirm)$/ }).first();
  if (await ack.count()) await mouseClick(p, ack).catch(() => {});
  await p.reload({ waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30 && !/AI model \*[\s\S]*Change AI model/.test(await p.innerText("body")); i++) await p.waitForTimeout(1000);
  const now = await current();
  // The page drops a trailing "(via inference profile)" from model names.
  if (!now.includes((model ?? provider).replace(/\s*\(.*\)$/, ""))) throw new Error(`Connect pressed but the agent shows: ${now}`);
  console.log(`✓ now: ${now}`);
});
