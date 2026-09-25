/**
 * What this bot is allowed to run, and the contract every automation keeps.
 *
 * THE REGISTRY IS THE SECURITY BOUNDARY. Anyone who can enqueue a job names a
 * script by string, so a name only resolves if it is a bare `.mjs` file already
 * present in `automations/` — no paths, no traversal, nothing computed. The
 * image bakes that directory in at a pinned revision, so "what can this bot do"
 * is answerable by reading a git tree rather than by trusting the queue.
 *
 * An automation module exports:
 *
 *   export const meta = {
 *     description: "one line — what it does, for whoever reads the registry",
 *     secrets: ["ACME_USERNAME", "ACME_PASSWORD"],   // env names, optional
 *     timeoutMs: 120_000,                            // optional, caps the job
 *   };
 *
 *   export async function run({ page, context, args, secrets, log, artifact }) {
 *     ...
 *     return { anything: "JSON-serialisable" };
 *   }
 *
 * `secrets` is the declared list resolved from the environment — an automation
 * never reads process.env itself, so a missing credential is caught before a
 * browser is launched rather than as a mystery timeout on a login page.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

export const AUTOMATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "automations");

/** Names only — cheap enough to call on every claim, so a redeploy needs no restart. */
export function listAutomations() {
  return readdirSync(AUTOMATIONS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
}

/**
 * Resolve a requested name to a module, or throw with the list of what IS
 * available — a bot that answers "no such automation" without saying what it
 * has turns a typo into a support conversation.
 */
export async function loadAutomation(requested) {
  const name = String(requested ?? "").trim().replace(/\.mjs$/, "");
  const available = listAutomations();

  if (!name || name !== name.replace(/[^A-Za-z0-9._-]/g, "")) {
    throw new Error(`Refusing ${JSON.stringify(requested)} — an automation name, not a path. Available: ${available.join(", ")}`);
  }
  if (!available.includes(name)) {
    throw new Error(`No automation named "${name}". Available: ${available.join(", ")}`);
  }

  const mod = await import(pathToFileURL(join(AUTOMATIONS_DIR, `${name}.mjs`)).href);
  if (typeof mod.run !== "function") {
    throw new Error(`automations/${name}.mjs does not export a run() function`);
  }
  return { name, meta: mod.meta ?? {}, run: mod.run };
}

/**
 * Collect the credentials an automation declared. Missing ones are named
 * TOGETHER — reporting them one per run means one deploy per missing secret.
 */
export function resolveSecrets(meta, name) {
  const wanted = Array.isArray(meta.secrets) ? meta.secrets : [];
  const secrets = {};
  const missing = [];
  for (const key of wanted) {
    const value = process.env[key];
    if (!value) missing.push(key);
    else secrets[key] = value;
  }
  if (missing.length) {
    throw new Error(`automations/${name}.mjs needs ${missing.join(", ")} in the bot's environment, and they are not set`);
  }
  return secrets;
}
