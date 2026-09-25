/**
 * Everything the bot needs from its environment, validated once at boot.
 *
 * It fails at STARTUP rather than on the first job. A bot that boots happily and
 * then fails every job it claims is worse than one that refuses to start: the
 * jobs are gone by then, marked failed, and the caller has already been told the
 * automation is broken when the truth is nobody set a URL.
 */
export const config = load();

function load() {
  const missing = [];
  const need = (name) => {
    const v = process.env[name];
    if (!v) missing.push(name);
    return v;
  };

  const claimUrl = need("TRAY_CLAIM_URL");
  const completeUrl = need("TRAY_COMPLETE_URL");

  if (missing.length) {
    throw new Error(
      `Missing required environment: ${missing.join(", ")}\n\n` +
        `Both are webhook URLs off the trigger step of your claim and complete\n` +
        `workflows in Tray (see "The Tray side you build" in README.md).\n` +
        `They are the only credential the bot has, so treat them as secrets.`,
    );
  }

  const lane = (process.env.BOT_LANE ?? "bot").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(lane)) {
    throw new Error(`BOT_LANE must be lowercase letters, digits and hyphens — got ${JSON.stringify(lane)}`);
  }

  return {
    claimUrl,
    completeUrl,
    /**
     * Which queue this bot drinks from. Two bots sharing a lane will race for
     * the same jobs; two bots with DIFFERENT script sets sharing a lane will
     * also fail each other's, which is the reason lanes exist at all.
     */
    lane,
    pollSeconds: positive("POLL_SECONDS", 5),
    /** Ceiling for any one job. An automation's own meta.timeoutMs wins if lower. */
    jobTimeoutMs: positive("JOB_TIMEOUT_SECONDS", 300) * 1000,
    headless: (process.env.HEADLESS ?? "true") !== "false",
    /**
     * Slows every interaction down so a person can follow it. For demos and for
     * debugging a selector — never for production, where it is pure latency.
     */
    slowMoMs: Number(process.env.SLOW_MO_MS ?? 0) || 0,
    /**
     * Records a video per job. Off by default because it costs disk on every
     * run, but it is the best evidence there is of what a bot actually did to
     * somebody's system — worth turning on for anything irreversible.
     */
    recordVideo: (process.env.RECORD_VIDEO ?? "false") === "true",
    artifactDir: process.env.ARTIFACT_DIR ?? "/artifacts",
    /** The result lands in a data table cell, so it goes back capped. */
    maxResultChars: positive("MAX_RESULT_CHARS", 4000),
    /** Stamped into every result so a failure can be traced to an image. */
    revision: process.env.GIT_SHA ?? "unknown",
  };
}

function positive(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number — got ${JSON.stringify(raw)}`);
  }
  return n;
}
