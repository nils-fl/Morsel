import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Public files the app doesn't need offline (the link preview is for crawlers, the GIF for the landing page).
const NOT_PRECACHED = new Set(['og-image.png', 'boot-animation.gif', '.DS_Store'])
/** Built files that aren't the app's: the landing page (and its stylesheet) and the downloads. */
const notTheApp = (name: string) => name === 'landing.html' || name.startsWith('assets/landing-') || name.startsWith('download/')

/** The Live script for the landing page's download (worker/index.ts counts it): live/Morsel as Morsel/ in a zip. */
function liveScriptZip(): Plugin {
  return {
    name: 'morsel-live-zip',
    apply: 'build',
    generateBundle() {
      const dir = resolve(import.meta.dirname, '../live/Morsel')
      const files: Record<string, Uint8Array> = {}
      const add = (path: string) => {
        for (const name of readdirSync(path).sort()) {
          const full = resolve(path, name)
          if (statSync(full).isDirectory()) {
            if (name !== '__pycache__') add(full)
          } else if (name.endsWith('.py')) {
            files[`Morsel/${relative(dir, full).replaceAll('\\', '/')}`] = readFileSync(full)
          }
        }
      }
      add(dir)
      this.emitFile({ type: 'asset', fileName: 'download/morsel-for-live.zip', source: zipSync(files, { level: 9 }) })
    },
  }
}

/** Writes dist/sw.js from sw.js, filled in with this build's files and a version that changes whenever one of them does. */
function serviceWorker(): Plugin {
  let root = ''
  let publicDir = ''
  return {
    name: 'morsel-service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root
      publicDir = config.publicDir
    },
    // After index.html is written into the bundle, so its font links can be read.
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const hash = createHash('sha256')
        const files = ['/app/']
        for (const [name, out] of Object.entries(bundle)) {
          if (notTheApp(name)) continue
          hash.update(out.type === 'chunk' ? out.code : out.source)
          if (name !== 'index.html') files.push(`/${name}`)
        }
        for (const name of readdirSync(publicDir).sort()) {
          if (NOT_PRECACHED.has(name)) continue
          hash.update(readFileSync(resolve(publicDir, name)))
          files.push(`/${name}`)
        }
        const html = bundle['index.html']
        const fontCss = html?.type === 'asset'
          ? [...String(html.source).matchAll(/href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))
          : []
        const build = { version: hash.digest('hex').slice(0, 12), files, fontCss }
        const source = readFileSync(resolve(root, 'sw.js'), 'utf8').replace('__BUILD__', JSON.stringify(build))
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), liveScriptZip(), serviceWorker()],
  build: {
    rolldownOptions: {
      // The app (served at /app/) and the landing page (served at /): worker/index.ts maps them.
      input: { app: resolve(import.meta.dirname, 'index.html'), landing: resolve(import.meta.dirname, 'landing.html') },
    },
  },
})
