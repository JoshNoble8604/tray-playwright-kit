/**
 * A page in the signed-in browser, plus the console's own bearer and a way to
 * call Tray's API with it. Library, not a script.
 *
 *   const s = await consoleSession(`https://app.tray.io/workspaces/${ws}/projects`);
 *   const wf = await s.api("GET", `/v2/workflows/${id}`);
 *   ...
 *   await s.done();              // closes the tab and exits; never the browser
 *
 * Calls run INSIDE the page (see rename-datatable-columns: from Node, several
 * private endpoints answered with an error page). The bearer is never logged.
 */
import { attach } from "./browser.mjs";

export async function consoleSession(url, { viewport = { width: 1500, height: 1100 } } = {}) {
  const { context } = await attach();
  const page = await context.newPage();
  await page.setViewportSize(viewport);

  let auth = null;
  page.on("request", (req) => {
    const h = req.headers().authorization;
    if (!auth && /api\.tray\.io/.test(req.url()) && h?.startsWith("Bearer ")) auth = h;
  });

  const done = async (code) => {
    await page.close().catch(() => {});
    // process.exit, never browser.close(): the browser is the user's.
    process.exit(code ?? process.exitCode);
  };

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  for (let i = 0; i < 40 && !auth; i++) await page.waitForTimeout(500);
  if (/\/login|\/signin|id\.tray\.ai/i.test(page.url())) {
    console.error("bounced to sign-in — sign in in the tray-console browser first");
    await done(2);
  }
  if (!auth) {
    console.error("never saw an authenticated request — is this browser signed in to Tray?");
    await done(2);
  }

  /** `path` may be absolute or start with "/" (then api.tray.io). Throws on non-2xx. */
  const api = (method, path, body) =>
    page.evaluate(
      async ([url, method, auth, body]) => {
        const r = await fetch(url, {
          method,
          headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${text.slice(0, 300)}`);
        try { return JSON.parse(text); } catch { return text; }
      },
      [path.startsWith("http") ? path : `https://api.tray.io${path}`, method, auth, body],
    );

  return { page, context, auth, api, done };
}

/**
 * Wraps a script body: errors print one line and exit 1, success exits 0, and
 * either way the tab closes and the browser stays.
 */
export async function run(session, body) {
  try {
    await body();
  } catch (err) {
    console.error(`✖ ${String(err?.message ?? err).split("\n")[0].replace(/^page\.evaluate: Error: /, "")}`);
    process.exitCode = 1;
  }
  await session.done();
}

/** Real mouse event at an element's centre — `el.click()` misses some of this app's handlers. */
export async function mouseClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box — not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
