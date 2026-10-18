// File format names for project and kit exports. Files exported before the rename to Morsel say "launchkit" and still load.
export const PROJECT_FORMAT = "morsel";
export const KIT_FORMAT = "morsel-kit";
const PROJECT_FORMATS = new Set([PROJECT_FORMAT, "launchkit"]);
const KIT_FORMATS = new Set([KIT_FORMAT, "launchkit-kit"]);

export const isProjectFormat = (f: unknown) => typeof f === "string" && PROJECT_FORMATS.has(f);
export const isKitFormat = (f: unknown) => typeof f === "string" && KIT_FORMATS.has(f);
