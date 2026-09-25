/**
 * Where a project tells the kit about ITSELF.
 *
 * These scripts are generic — they drive Tray's console, which is the same
 * console for everyone. What is not generic is which workspace and project they
 * point at, and (for the APIM scripts) which workflows are being migrated to
 * which paths. Hardcoding that inside the scripts is exactly what stops them being
 * usable anywhere else.
 *
 * So the kit loads a config from the CONSUMING project, resolved in this order:
 *
 *   1. `--config <path>` on the command line
 *   2. `TRAY_CONSOLE_CONFIG` in the environment
 *   3. `tray-console.config.mjs`, searched from the working directory upwards
 *
 * The upward search is what makes `npx tray-console list-operations` work from
 * anywhere inside a repository rather than only from its root.
 *
 * A config exports `ENVIRONMENTS` (required) and, only if you are migrating
 * workflows to API Management, `MIGRATIONS`. See `example.config.mjs`.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILENAME = "tray-console.config.mjs";

/** `--config <path>` from argv, if present. */
function fromArgv() {
  const i = process.argv.indexOf("--config");
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Nearest config at or above `start`. */
function search(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function configPath() {
  const explicit = fromArgv() ?? process.env.TRAY_CONSOLE_CONFIG;
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(p)) throw new Error(`no config at ${p}`);
    return p;
  }
  const found = search(process.cwd());
  if (!found) {
    throw new Error(
      `No ${CONFIG_FILENAME} found in ${process.cwd()} or any parent.\n\n` +
        `Create one (see example.config.mjs in the kit), or pass --config <path>,\n` +
        `or set TRAY_CONSOLE_CONFIG.`,
    );
  }
  return found;
}

let cached = null;
async function load() {
  if (cached) return cached;
  const p = configPath();
  const mod = await import(pathToFileURL(p).href);
  if (!mod.ENVIRONMENTS || typeof mod.ENVIRONMENTS !== "object") {
    throw new Error(`${p} does not export ENVIRONMENTS`);
  }
  cached = { ...mod, __path: p };
  return cached;
}

/**
 * One environment by name, defaulting to the first declared.
 *
 * Named rather than positional because the whole point of the table is that the
 * same migration runs against dev and production, and a script that took
 * "whichever came first" would make the dangerous one the default.
 */
export async function environment(name) {
  const cfg = await load();
  const names = Object.keys(cfg.ENVIRONMENTS);
  const key = name ?? names[0];
  const env = cfg.ENVIRONMENTS[key];
  if (!env) {
    throw new Error(
      `unknown environment '${key}'. Known: ${names.join(", ")}.\n` +
        `Add it to ENVIRONMENTS in ${cfg.__path}.`,
    );
  }
  for (const required of ["workspaceId", "projectId"]) {
    if (!env[required]) throw new Error(`environment '${key}' has no ${required}`);
  }
  // Derivable, so a config need not repeat it and cannot get it inconsistent.
  return { name: key, apiHost: `${env.projectId}-api.trayapp.io`, ...env };
}

/** The APIM migration plan. Empty unless the project declares one. */
export async function migrations() {
  const cfg = await load();
  return cfg.MIGRATIONS ?? [];
}

export async function excluded() {
  const cfg = await load();
  return cfg.EXCLUDED ?? [];
}

/**
 * The operation NAME Tray shows in its list, derived from the path.
 *
 * Derived rather than configured: an operation whose name and path disagree is
 * a row nobody can match to anything, and it was already being computed this way
 * in two places.
 */
export function operationName(migration) {
  return (migration.operationName ?? migration.path).replace(/[^a-z0-9]/gi, "");
}
