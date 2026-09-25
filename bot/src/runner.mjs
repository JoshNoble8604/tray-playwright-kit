/**
 * The bot. Asks Tray for work in its lane, drives a browser, reports back.
 *
 * WHY IT POLLS. Tray never calls in. The bot can then live behind a NAT, on a
 * private subnet, or inside a VPN with the apps it automates, and needs no
 * inbound port, no tunnel and no public certificate. It is also what makes the
 * failure mode honest: a bot that is down simply stops asking, and the caller
 * gets `timeout` rather than a connection error dressed up as a result.
 *
 * ONE JOB AT A TIME, deliberately. Browser automation against a real app is
 * usually order-sensitive and frequently rate-limited, and a second concurrent
 * session on the same account is the classic way to get one logged out. Scale by
 * running more bots — give each its own lane, or share a lane to load-balance.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { config } from "./config.mjs";
import { acquireLaneLock } from "./lock.mjs";
import { listAutomations, loadAutomation, resolveSecrets } from "./registry.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Finish the job in hand rather than abandoning it half-done in a real app.
    // An abandoned job stays `running` and the caller times out — worse than
    // taking a few more seconds to shut down cleanly.
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n  ${signal} — finishing the current job, then stopping. Again to force.`);
  });
}

async function post(url, body, { timeoutMs = 30_000 } = {}) {
  // Without a timeout a hung connection blocks the loop for ever — the bot stops
  // claiming and looks, from Tray, exactly like a bot that was switched off.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 300)}`);
  }
}

/**
 * Reporting an outcome is retried; claiming is not.
 *
 * The asymmetry is the point. A claim that fails costs nothing — the job is
 * still on the queue and the next poll gets it. A COMPLETION that fails strands
 * a job as `running` for ever: the caller waits out its whole timeout and is
 * told the automation did not happen, when it did. For anything irreversible
 * that is the worst answer the system can give, because the human response is to
 * run it again.
 *
 * So the result is pushed hard, and if it still cannot be delivered it is
 * written to disk rather than dropped — a file somebody can replay beats a
 * result that only ever existed in a log line.
 */
async function report(jobId, status, result) {
  const delays = [0, 2_000, 5_000, 15_000, 30_000];
  let lastErr;
  for (const [attempt, delay] of delays.entries()) {
    if (delay) await sleep(delay);
    try {
      await post(config.completeUrl, { job_id: jobId, status, result });
      if (attempt > 0) console.log(`  reported ${jobId} on attempt ${attempt + 1}`);
      return true;
    } catch (err) {
      lastErr = err;
      console.error(`  report attempt ${attempt + 1}/${delays.length} failed: ${err.message}`);
    }
  }
  const path = join(config.artifactDir, jobId, "unreported-result.json");
  try {
    mkdirSync(join(config.artifactDir, jobId), { recursive: true });
    writeFileSync(path, JSON.stringify({ job_id: jobId, status, result }, null, 2));
    console.error(`  COULD NOT REPORT ${jobId} after ${delays.length} attempts (${lastErr?.message}).`);
    console.error(`  The work WAS done. Result saved to ${path} — replay it against the complete webhook.`);
  } catch {
    console.error(`  COULD NOT REPORT ${jobId} AND could not save it: ${lastErr?.message}`);
  }
  return false;
}

/** The result is stored in a data table cell, so it goes back bounded. */
function capped(value) {
  const json = JSON.stringify(value ?? null);
  if (json.length <= config.maxResultChars) return value;
  return {
    truncated: true,
    chars_dropped: json.length - config.maxResultChars,
    preview: json.slice(0, config.maxResultChars),
  };
}

async function execute(job) {
  const automation = await loadAutomation(job.script);
  const secrets = resolveSecrets(automation.meta, automation.name);

  const budget = Math.min(config.jobTimeoutMs, automation.meta.timeoutMs ?? config.jobTimeoutMs);
  const jobDir = join(config.artifactDir, job.job_id);
  mkdirSync(jobDir, { recursive: true });

  const logLines = [];
  const log = (...parts) => {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    logLines.push(line);
    console.log(`    ${line}`);
  };
  /** Automations save evidence through this so every file lands under the job id. */
  const artifact = (filename, contents) => {
    const path = join(jobDir, filename);
    writeFileSync(path, contents);
    log(`artifact: ${filename}`);
    return path;
  };

  const browser = await chromium.launch({ headless: config.headless, slowMo: config.slowMoMs });
  const started = Date.now();
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1500, height: 1300 },
      ...(config.recordVideo ? { recordVideo: { dir: jobDir, size: { width: 1500, height: 1300 } } } : {}),
    });
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();

    const work = automation.run({ page, context, browser, args: job.args ?? {}, secrets, log, artifact });
    const timeout = sleep(budget).then(() => {
      throw new Error(`automation exceeded its ${Math.round(budget / 1000)}s budget`);
    });

    let data;
    try {
      data = await Promise.race([work, timeout]);
    } catch (err) {
      // Evidence first — a screenshot of the page as it stood is worth more than
      // the stack, and it is gone the moment the browser closes.
      await page
        .screenshot({ path: join(jobDir, "failure.png"), fullPage: true })
        .then(() => log("artifact: failure.png"))
        .catch(() => log("could not screenshot the failure"));
      throw err;
    }

    return {
      ok: true,
      data: capped(data),
      log: logLines.slice(-40),
      duration_ms: Date.now() - started,
      revision: config.revision,
    };
  } finally {
    // The video is only flushed to disk when the CONTEXT closes, and closing the
    // browser first throws that away — including the recording of the failure
    // you most wanted to watch. Context first, always.
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const lock = acquireLaneLock(config.lane);

const automations = listAutomations();
console.log(`\n  Bot up on lane "${config.lane}", asking every ${config.pollSeconds}s.`);
console.log(`  Revision ${config.revision}, ${config.headless ? "headless" : "headed"}.`);
console.log(`  Automations (${automations.length}): ${automations.join(", ") || "none — automations/ is empty"}\n`);

while (!stopping) {
  let job;
  try {
    job = await post(config.claimUrl, { lane: config.lane });
  } catch (err) {
    // A workspace that is briefly unreachable is not a reason to exit. The whole
    // premise of a bot is that it is still here when Tray comes back.
    console.error(`  claim failed: ${err.message}`);
    await sleep(config.pollSeconds * 1000);
    continue;
  }

  if (!job?.found) {
    await sleep(config.pollSeconds * 1000);
    continue;
  }

  console.log(`\n▸ ${job.job_id}  ${job.script}  ${JSON.stringify(job.args ?? {})}`);

  let status = "done";
  let result;
  try {
    result = await execute(job);
  } catch (err) {
    status = "failed";
    result = {
      ok: false,
      error: String(err?.message ?? err),
      duration_ms: 0,
      revision: config.revision,
    };
  }

  if (await report(job.job_id, status, result)) {
    console.log(`◂ ${job.job_id}  ${status}${result.duration_ms ? ` (${result.duration_ms}ms)` : ""}\n`);
  }
}

lock.release();
console.log("  Stopped.");
