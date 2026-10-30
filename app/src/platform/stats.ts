// Tells the site's stats (worker/index.ts) that something happened in the hosted app: one beacon with the event's
// name, no cookies, nothing stored. Not in dev, tests or the desktop app.
import { isNative } from "./native";

type StatsEvent = "launchkey";

const sent = new Set<StatsEvent>();

/** Counts `event` once per page load. */
export function countOnce(event: StatsEvent) {
  if (!import.meta.env.PROD || isNative() || sent.has(event) || typeof navigator.sendBeacon !== "function") return;
  sent.add(event);
  navigator.sendBeacon("/api/event", event);
}
