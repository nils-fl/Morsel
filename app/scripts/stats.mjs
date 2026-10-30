// Prints the site's counts (worker/index.ts writes them to Workers Analytics Engine): landing page visits, app opens,
// Live script downloads and Launchkey connections, per day, with where visitors came from and their countries.
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Account → Account Analytics → Read).
// Run: npm run stats [days, default 30]
const DATASET = "morsel_events"; // wrangler.jsonc
const EVENTS = ["landing", "app", "download", "launchkey"];

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read). See the README's Hosting section.");
  process.exit(1);
}
const days = Math.max(1, Math.floor(Number(process.argv[2] ?? 30)) || 30);
const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;

/** Rows of an Analytics Engine SQL query. Each row stands for _sample_interval events, so counts are sums of it. */
async function query(sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: `${sql} FORMAT JSON`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine: ${res.status} ${text}`);
  return JSON.parse(text).data;
}

const perDay = await query(
  `SELECT toDate(timestamp) AS day, blob1 AS event, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} GROUP BY day, event ORDER BY day`,
);
const from = await query(
  `SELECT blob3 AS source, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} AND blob1 = 'landing' GROUP BY source ORDER BY n DESC LIMIT 15`,
);
const countries = await query(
  `SELECT blob2 AS country, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${since} AND blob1 IN ('landing', 'app') GROUP BY country ORDER BY n DESC LIMIT 15`,
);

const table = new Map();
const totals = Object.fromEntries(EVENTS.map((e) => [e, 0]));
for (const { day, event, n } of perDay) {
  if (!table.has(day)) table.set(day, Object.fromEntries(EVENTS.map((e) => [e, 0])));
  table.get(day)[event] = Number(n);
  totals[event] = (totals[event] ?? 0) + Number(n);
}

console.log(`Morsel, the last ${days} days`);
console.log("landing = landing page visits, app = app opens, download = Live script downloads, launchkey = app sessions with a Launchkey\n");
console.table(Object.fromEntries([...table, ["total", totals]]));
console.log("Where landing page visitors came from (site = a page of Morsel's, none = typed, a bookmark or an app):");
console.table(Object.fromEntries(from.map((r) => [r.source || "none", Number(r.n)])));
console.log("Countries (landing and app):");
console.table(Object.fromEntries(countries.map((r) => [r.country || "?", Number(r.n)])));
