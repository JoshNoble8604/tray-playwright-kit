/**
 * One bot per lane on one host, enforced rather than remembered.
 *
 * WHY THIS EXISTS. Three bots were once started on the same lane by accident,
 * because the command used to stop the previous one matched nothing and reported
 * success anyway. They all polled, they all wrote to the same log, and the
 * interleaved output made a single job look as though it had run twice — which
 * sent the next half hour into hunting a double-claim bug in Tray that did not
 * exist.
 *
 * The duplicate execution was real, though, and that is the danger: two bots on
 * one lane can both claim before either flips the row to `running`, and an RPA
 * job that runs twice is an invoice paid twice. Tray cannot prevent it — the
 * data table has no conditional update — so the host does.
 *
 * A PID file, not a mutex, because the failure to defend against is a person
 * starting a second bot, not a race between threads.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export function acquireLaneLock(lane) {
  const path = join(tmpdir(), `playwright-bot-${lane}.pid`);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const previous = Number(readFileSync(path, "utf8").trim());
    if (previous && isAlive(previous)) {
      throw new Error(
        `A bot is already running on lane "${lane}" (pid ${previous}).\n\n` +
          `Two bots on one lane can claim the same job before either marks it running,\n` +
          `so the second one is refused. Stop the first with:  kill ${previous}\n` +
          `and CHECK it is gone — ps -eo pid,args | grep runner.mjs — before restarting.\n` +
          `To run a second bot deliberately, give it its own lane: BOT_LANE=<something-else>`,
      );
    }
    // A stale file from a bot that was killed. Taking it over is correct: the
    // process it names is gone, so nothing is being protected.
    console.log(`  (clearing a stale lock from pid ${previous})`);
  }

  writeFileSync(path, String(process.pid));
  const release = () => {
    try {
      // Only release OUR lock. A crashed bot whose lock was taken over by a
      // successor must not have that successor's lock deleted on the way out.
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {}
  };
  process.on("exit", release);
  return { path, release };
}

/** Signal 0 tests for existence without delivering anything. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
