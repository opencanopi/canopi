// Desktop gives Rolldown two outputs, whose chunk names cannot be told apart; its chunks are the editions case's.
export default ({ mode }) => ({
  build: {
    outDir: mode === 'web' ? '../editions/web-out' : '../editions/desktop-out',
    rolldownOptions: { output: mode === 'web' ? { chunkFileNames: 'assets/[name]-[hash:16].js' } : [{}, {}] },
  },
});
