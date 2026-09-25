#!/usr/bin/env node
/**
 * `tray-console <script> [args…]` — run one of the kit's scripts.
 *
 * A single entry point rather than fifteen paths to remember, and it is what
 * makes the kit usable from a project that has not vendored it: the scripts live
 * wherever npm put them, and this resolves them.
 *
 * The allowlist is the whole list of files in `src/`, resolved by exact name. It
 * is not decoration — `runner.mjs` accepts a script name from a Tray webhook, and
 * without a hard boundary that webhook is a remote shell.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "src");

/*
 * Libraries, not scripts. They export shapes and helpers the scripts import;
 * running one does nothing and offering it in the menu invites somebody to try.
 */
const LIBRARIES = new Set(["config", "session"]);

const available = readdirSync(srcDir)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => f.replace(/\.mjs$/, ""))
  .filter((f) => !LIBRARIES.has(f))
  .sort();

const [, , name, ...rest] = process.argv;

if (!name || name === "--help" || name === "-h") {
  console.log(`
  tray-console <script> [args…]

  Scripts:
${available.map((a) => `    ${a}`).join("\n")}

  Every script reads the project's tray-console.config.mjs, found by walking up
  from the working directory. Override with --config <path> or
  TRAY_CONSOLE_CONFIG.

  Before anything else:
    tray-console login      once — sign in, then close the window
    tray-console browser    leave running; the others attach to it
`);
  process.exit(name ? 0 : 1);
}

if (!available.includes(name)) {
  console.error(`\n  unknown script '${name}'.\n  Available: ${available.join(", ")}\n`);
  process.exit(1);
}

// argv is rebuilt so each script sees its own name at [1] and its own args from
// [2], exactly as when it is run directly. Several read process.argv[2].
process.argv = [process.argv[0], join(srcDir, `${name}.mjs`), ...rest];
await import(pathToFileURL(join(srcDir, `${name}.mjs`)).href);
