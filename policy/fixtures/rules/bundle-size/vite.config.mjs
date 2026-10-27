// The planted build, laid out as desktop/web/vite.config.ts builds both editions (Desktop's chunk names carry Vite's
// 8-character hash, Web's 16), its output dirs not named dist, which .gitignore ignores: Web's webworkerAll chunk is
// above its ceiling times one plus its tolerance (over-budget), and Desktop has a chunk no budget names (unlisted).
export default ({ mode }) => ({
  build: {
    outDir: mode === 'web' ? 'recorded-web' : 'recorded-desktop',
    rolldownOptions: { output: mode === 'web' ? { chunkFileNames: 'assets/[name]-[hash:16].js' } : {} },
  },
});
