/**
 * Proves the whole loop without touching anything real.
 *
 * Worth having as a first-class automation rather than a test: when a deploy
 * goes wrong, "can the bot claim a job, launch a browser, load a page and report
 * back?" is the question you want answered before you start debugging a login
 * flow. It needs no secrets, so it also works on a bot that is otherwise
 * unconfigured.
 */
export const meta = {
  description: "Loads a page and returns its title. No credentials, no side effects.",
  timeoutMs: 60_000,
};

export async function run({ page, args, log }) {
  const url = String(args.url ?? "https://example.com");
  log(`navigating to ${url}`);

  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  const title = await page.title();
  log(`title: ${title}`);

  return {
    url: page.url(),
    status: response?.status() ?? null,
    title,
    checked_at: new Date().toISOString(),
  };
}
