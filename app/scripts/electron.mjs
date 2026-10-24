// The desktop app (electron/): bundles the main process and the preload with esbuild into dist-electron/.
//   node scripts/electron.mjs build   bundle (the web build comes from `npm run build`)
//   node scripts/electron.mjs dev     bundle, start Vite's dev server and open the app on it
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];

await build({
  absWorkingDir: root,
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: mode === "dev",
  logLevel: "warning",
});

if (mode === "dev") {
  const { createServer } = await import("vite");
  const server = await createServer({ root });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite's dev server has no local URL");
  const electron = (await import("electron")).default;
  const app = spawn(electron, ["."], { cwd: root, stdio: "inherit", env: { ...process.env, MORSEL_DEV_URL: url } });
  app.on("exit", async (code) => {
    await server.close();
    process.exit(code ?? 0);
  });
} else if (mode !== "build") {
  console.error("Usage: node scripts/electron.mjs build | dev");
  process.exit(1);
}
