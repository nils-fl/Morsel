import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Public files the app doesn't need offline (the link preview is for crawlers).
const NOT_PRECACHED = new Set(['og-image.png', '.DS_Store'])

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
        const files = ['/']
        for (const [name, out] of Object.entries(bundle)) {
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
  plugins: [react(), serviceWorker()],
})
