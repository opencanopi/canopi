// Recorded editions laid out as desktop/web/vite.config.ts builds them: Desktop's chunk names carry Vite's 8-character
// hash, Web's 16; the output dirs are not named dist, which .gitignore ignores.
export default ({ mode }) => ({
  build: {
    outDir: mode === 'web' ? 'web-out' : 'desktop-out',
    rolldownOptions: { output: mode === 'web' ? { chunkFileNames: 'assets/[name]-[hash:16].js' } : {} },
  },
});
