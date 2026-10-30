import { describe, expect, it } from "vitest";
import worker from "./index";

const DOWNLOAD = "/download/morsel-for-live.zip";
const SITE = "https://morsel.example";
const PAGE = { "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Chrome/140" };

/** The Worker with fake static files (answering with the path asked for) and a list of what it counted. */
function run(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const points: { blobs?: string[] }[] = [];
  const served: string[] = [];
  const env = {
    ASSETS: { fetch: async (req: Request) => (served.push(new URL(req.url).pathname), new Response("file")) },
    EVENTS: { writeDataPoint: (p: { blobs?: string[] }) => void points.push(p) },
  };
  const res = worker.fetch(new Request(SITE + path, init), env);
  return { res, served, counted: async () => (await res, points.map((p) => p.blobs)) };
}

describe("worker", () => {
  it("serves the landing page at / and the app under /app/", async () => {
    const landing = run("/", { headers: PAGE });
    expect(await landing.counted()).toEqual([["landing", "", ""]]);
    expect(landing.served).toEqual(["/landing"]);

    const app = run("/app/", { headers: { ...PAGE, referer: `${SITE}/` } });
    expect(await app.counted()).toEqual([["app", "", "site"]]);
    expect(app.served).toEqual(["/"]);
    const deep = run("/app/anything");
    await deep.res;
    expect(deep.served).toEqual(["/"]);
  });

  it("sends /app to /app/", async () => {
    const res = await run("/app").res;
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${SITE}/app/`);
  });

  it("counts people, not prefetches, precaches or bots", async () => {
    expect(await run("/", { headers: { ...PAGE, referer: "https://github.com/nils-fl/Morsel" } }).counted()).toEqual([["landing", "", "github.com"]]);
    expect(await run("/").counted()).toEqual([]); // the service worker's precache: not a document
    expect(await run("/", { headers: { ...PAGE, "sec-purpose": "prefetch" } }).counted()).toEqual([]);
    expect(await run("/", { headers: { ...PAGE, "user-agent": "Googlebot/2.1" } }).counted()).toEqual([]);
    expect(await run("/sw.js", { headers: PAGE }).counted()).toEqual([]);
  });

  it("counts a download once, not the rest of a resumed one", async () => {
    const dl = run(DOWNLOAD, { headers: PAGE });
    expect(await dl.counted()).toEqual([["download", "", ""]]);
    expect(dl.served).toEqual([DOWNLOAD]);
    expect(await run(DOWNLOAD, { headers: { ...PAGE, range: "bytes=0-" } }).counted()).toHaveLength(1);
    expect(await run(DOWNLOAD, { headers: { ...PAGE, range: "bytes=5000-" } }).counted()).toEqual([]);
  });

  it("takes the app's known events from its own pages only", async () => {
    const beacon = (body: string, site = "same-origin") => run("/api/event", { method: "POST", body, headers: { "sec-fetch-site": site } });
    const ok = beacon("launchkey");
    expect(await ok.counted()).toEqual([["launchkey", "", ""]]);
    expect((await ok.res).status).toBe(204);
    expect(await beacon("anything").counted()).toEqual([]);
    expect(await beacon("launchkey", "cross-site").counted()).toEqual([]);
    expect((await run("/api/event").res).status).toBe(405);
  });
});
