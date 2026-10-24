// Starred files, folders and samples: a Favorites folder in the library drawer, the sample picker and Browse.
// Kept by entry key (tree.ts entryKey); one whose target is gone is hidden, not dropped, so reconnecting brings it back.
import { loadFavorites, saveFavorites } from "../state/persist";
import { get, set } from "../state/store";
import { entryKey, type Entry } from "./tree";

export async function initFavorites() {
  set({ favorites: await loadFavorites() });
}

function save(favorites: string[]) {
  set({ favorites });
  saveFavorites(favorites).catch((err) => set({ status: `Couldn't save the favorites: ${(err as Error).message}` }));
}

export const isFavorite = (e: Entry) => get().favorites.includes(entryKey(e));

export function toggleFavorite(e: Entry) {
  const key = entryKey(e);
  const now = get().favorites;
  save(now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
}

/** Rewrite the favorites under a path that moved (a renamed connected or library folder). */
export function moveFavorites(from: string, to: string) {
  const moved = get().favorites.map((key) => {
    const i = key.indexOf(":");
    const path = key.slice(i + 1);
    return path === from || path.startsWith(from + "/") ? key.slice(0, i + 1) + to + path.slice(from.length) : key;
  });
  if (moved.some((k, i) => k !== get().favorites[i])) save(moved);
}

/** Forget the favorites of samples that were deleted. */
export function dropSampleFavorites(ids: string[]) {
  const gone = new Set(ids.map((id) => `sample:${id}`));
  const left = get().favorites.filter((k) => !gone.has(k));
  if (left.length !== get().favorites.length) save(left);
}
