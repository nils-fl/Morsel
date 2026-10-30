// The Cloudflare Worker in front of the built site (dist/): the landing page at /, the app at /app/, the Live script's
// zip at DOWNLOAD, and a count of each. The counts go to Workers Analytics Engine (npm run stats reads them): an event
// name, the visitor's country and where they came from (a site's host name). No cookies, nothing stored on the
// visitor's device, no IP addresses.

interface Assets {
  fetch(req: Request): Promise<Response>;
}
interface Dataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}
interface Env {
  ASSETS: Assets;
  /** Missing in `wrangler dev` without the binding: then nothing is counted. */
  EVENTS?: Dataset;
}

// The Workers runtime takes only handlers as the module's exports.
const DOWNLOAD = "/download/morsel-for-live.zip"; // written by vite.config.ts
/** What the app reports itself (platform/stats.ts), besides the pages and the download counted here. */
const APP_EVENTS = new Set(["launchkey"]);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/event") return appEvent(req, env);
    if (path === "/") {
      if (isPageView(req)) count(env, req, "landing");
      return env.ASSETS.fetch(new Request(new URL("/landing", url), req));
    }
    if (path === "/app") return Response.redirect(new URL("/app/", url).href, 301);
    if (path.startsWith("/app/")) {
      if (isPageView(req)) count(env, req, "app");
      // A single-page app: every page under /app/ is its index.html.
      return env.ASSETS.fetch(new Request(new URL("/", url), req));
    }
    // A resumed download asks for the rest of the file: counted once, at its start.
    if (path === DOWNLOAD && req.method === "GET" && !isBot(req) && !/^bytes=[1-9]/.test(req.headers.get("range") ?? "")) {
      count(env, req, "download");
    }
    return env.ASSETS.fetch(req);
  },
};

/** The app's beacon: one known event name as the body, from a page of this site. */
async function appEvent(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const name = (await req.text()).trim();
  if (APP_EVENTS.has(name) && req.headers.get("sec-fetch-site") === "same-origin" && !isBot(req)) count(env, req, name);
  return new Response(null, { status: 204 });
}

/** A person opening the page: a browser loading it as a document, not a prefetch, a service worker's precache or a bot. */
const isPageView = (req: Request) =>
  req.method === "GET" && req.headers.get("sec-fetch-dest") === "document" && !req.headers.get("sec-purpose") && !isBot(req);

const isBot = (req: Request) => BOT.test(req.headers.get("user-agent") ?? "");

function count(env: Env, req: Request, name: string) {
  const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? "";
  env.EVENTS?.writeDataPoint({ indexes: [name], blobs: [name, country, cameFrom(req)], doubles: [1] });
}

/** Where the visitor came from: another site's host name, "site" for a page of this one, "" for none (typed or a bookmark). */
function cameFrom(req: Request): string {
  const referer = req.headers.get("referer");
  if (!referer) return "";
  try {
    const host = new URL(referer).hostname;
    return host === new URL(req.url).hostname ? "site" : host;
  } catch {
    return "";
  }
}
