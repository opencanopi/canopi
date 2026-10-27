import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath, URL } from 'node:url'

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
// The PDF fonts' one script (plain JavaScript, run by node too): imported by URL, typed here.
const { pdfFontsPlugin } = (await import(new URL('../scripts/prepare-pdf-fonts.mjs', import.meta.url).href)) as { pdfFontsPlugin(): Plugin }
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('The UI gallery is development-only.')
  return {
    root: path('.'),
    cacheDir: path('../node_modules/.vite-ui-gallery'),
    // The PDF export workspace imports the prepared fonts as the app does (pdfFontsPlugin).
    publicDir: false,
    // As the app's Web build without a generated catalog; the gallery's catalog is memory data.
    define: { __CANOPI_WEB_CATALOG_PATH__: JSON.stringify('assets/catalog/none/') },
    plugins: [preact(), pdfFontsPlugin()],
    resolve: { alias: {
      '@tauri-apps/api/core': path('./memory-backend.ts'),
      '@tauri-apps/plugin-dialog': path('./memory-dialogs.ts'),
      '#species-catalog-live': path('../src/app/plant-browser/live.desktop.ts'),
      '#platform': path('../src/platform/browser.ts'),
      '#canvas-pdf-platform': path('./canvas-pdf-platform.ts'),
      '#budget-export-platform': path('./budget-export.ts'),
      '#geocoding-transport': path('../src/app/geocoding/transport.browser.ts'),
    } },
    // As the app's (vite.config.ts): `state=lidar-raster` draws through Desktop's raster renderer, whose WASM
    // decoders resolve their .wasm beside their own module and whose TIFF codecs use top-level await.
    optimizeDeps: {
      exclude: ['cog-tiler-wasm', 'whitebox-wasm'],
      rolldownOptions: { transform: { target: 'es2022' } },
    },
    worker: { format: 'es' as const },
    server: { host: '127.0.0.1', port: 1422, strictPort: true, fs: { allow: [path('..')] } },
  }
})
