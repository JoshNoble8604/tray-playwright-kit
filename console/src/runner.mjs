/**
 * The bridge between a Tray workflow and the scripts in this directory.
 *
 * WHY IT POLLS RATHER THAN LISTENS. Everything here needs the signed-in browser
 * that `browser.mjs` holds open, and that browser is on a laptop behind NAT with
 * no public address. So Tray never calls us — we call Tray. Two webhooks in a
 * Tray project holding the claim/complete workflows: one hands out a job, one
 * takes the outcome back.
 * No tunnel, no inbound port, and a closed lid is just a runner that stopped
 * asking.
 *
 *   npx tray-console browser   # window one — sign in, leave open
 *   npx tray-console runner    # window two — leave running
 *
 * THE ALLOWLIST IS THE SECURITY BOUNDARY. Anyone who can POST to the claim
 * webhook can name a script, so `resolveScript` refuses anything that is not a
 * plain `.mjs` filename already sitting in THIS directory. Without that, the
 * workflow is a remote shell on your machine.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(homedir(), ".config", "tray", "playwright-runner.json");

/**
 * THIS BOT'S LANE, and it must not be the default one.
 *
 * The general-purpose RPA bot (`playwright-bot/`) drinks from lane "bot" and
 * carries a completely different set of scripts. Sharing a lane would have the
 * two racing for each other's jobs and failing them for naming a script the
 * claimer does not have — so the attended, laptop-only scripts here get their
 * own queue. A job reaches this runner only if the caller asked for lane
 * "console".
 */
const LANE = process.env.PW_RUNNER_LANE ?? "console";

/** Output is stored in a data table cell, so it goes in tail-first and capped. */
const MAX_OUTPUT = 4000;
const POLL_SECONDS = Number(process.env.PW_RUNNER_POLL ?? 3);
const DEFAULT_TIMEOUT_MS = 300_000;

function config() {
  const claim = process.env.TRAY_CLAIM_URL;
  const complete = process.env.TRAY_COMPLETE_URL;
  if (claim && complete) return { claim_url: claim, complete_url: complete };

  let file;
  try {
    file = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    throw new Error(
      `No runner config. Copy the two webhook URLs out of the Tray UI\n` +
        `(your claim/complete workflows → the trigger step of each) into\n` +
        `${CONFIG}:\n\n` +
        `  { "claim_url": "https://...", "complete_url": "https://..." }\n\n` +
        `or set TRAY_CLAIM_URL and TRAY_COMPLETE_URL.`,
    );
  }
  if (!file.claim_url || !file.complete_url) {
    throw new Error(`${CONFIG} needs both "claim_url" and "complete_url".`);
  }
  return file;
}

/**
 * The allowlist. A name only resolves if it is a bare `.mjs` file that already
 * exists here — no paths, no traversal, no arbitrary binaries. The directory is
 * read fresh each time so a newly committed script needs no restart.
 */
function resolveScript(name) {
  const wanted = String(name ?? "").trim();
  if (!wanted || wanted !== wanted.replace(/[/\\]/g, "")) {
    throw new Error(`Refusing "${wanted}" — a bare .mjs file name from the kit's src/ is the only thing allowed`);
  }
  const available = readdirSync(UI_DIR).filter((f) => f.endsWith(".mjs") && f !== "runner.mjs");
  if (!available.includes(wanted)) {
    throw new Error(`No such script: "${wanted}". Available: ${available.join(", ")}`);
  }
  return join(UI_DIR, wanted);
}

function tail(text) {
  const s = String(text ?? "");
  return s.length <= MAX_OUTPUT ? s : `…(${s.length - MAX_OUTPUT} chars trimmed)…\n` + s.slice(-MAX_OUTPUT);
}

function run(scriptPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: join(UI_DIR, "..", "..", ".."),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: timedOut ? -1 : code,
        timed_out: timedOut,
        stdout: tail(stdout),
        stderr: tail(stderr),
        duration_ms: Date.now() - started,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exit_code: -1, timed_out: false, stdout: tail(stdout), stderr: String(err), duration_ms: Date.now() - started });
    });
  });
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { claim_url, complete_url } = config();
console.log(`\n  Runner up on lane "${LANE}". Asking Tray for work every ${POLL_SECONDS}s.`);
console.log(`  Scripts it will run: ${readdirSync(UI_DIR).filter((f) => f.endsWith(".mjs") && f !== "runner.mjs").length} in ${UI_DIR}`);
console.log("  Ctrl-C to stop.\n");

for (;;) {
  let job;
  try {
    job = await post(claim_url, { lane: LANE });
  } catch (err) {
    // A workspace that is briefly unreachable is not a reason to exit — the
    // whole point of this process is that it is still here when Tray comes back.
    console.error(`  claim failed: ${err.message}`);
    await sleep(POLL_SECONDS * 1000);
    continue;
  }

  if (!job?.found) {
    await sleep(POLL_SECONDS * 1000);
    continue;
  }

  // `args` is opaque JSON on the queue, because the bot lane passes an OBJECT to
  // its automations. These scripts take a command line, so anything that is not
  // a list is refused rather than spread into argv as undefined.
  const argv = Array.isArray(job.args) ? job.args.map(String) : [];
  console.log(`\n▸ ${job.job_id}  ${job.script} ${argv.join(" ")}`);

  let status = "done";
  let result;
  try {
    if (job.args != null && !Array.isArray(job.args)) {
      throw new Error(`lane "${LANE}" takes args as a list of command-line arguments, got ${JSON.stringify(job.args)}`);
    }
    const scriptPath = resolveScript(job.script);
    result = await run(scriptPath, argv, DEFAULT_TIMEOUT_MS);
    // The script's own exit code decides the verdict — "the process ran" and
    // "the thing worked" are different claims, same as everywhere else here.
    if (result.exit_code !== 0) status = "failed";
  } catch (err) {
    status = "failed";
    result = { exit_code: -1, stdout: "", stderr: String(err.message ?? err), duration_ms: 0 };
  }

  try {
    await post(complete_url, { job_id: job.job_id, status, result });
    console.log(`◂ ${job.job_id}  ${status} (exit ${result.exit_code}, ${result.duration_ms}ms)\n`);
  } catch (err) {
    // The job stays "running" in the table and the caller will time out. Say so
    // loudly — this is the one failure the Tray side cannot see for itself.
    console.error(`  COULD NOT REPORT ${job.job_id}: ${err.message}`);
  }
}
