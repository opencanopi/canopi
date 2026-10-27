import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'
import { pdfFontsPlugin } from '../prepare-pdf-fonts.mjs'
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), base: './', publicDir: false,
  plugins: [preact(), pdfFontsPlugin()], build: { outDir: '../../dist-pdf-validation', emptyOutDir: true } })
