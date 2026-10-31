// Desktop names chunks with no [hash]; its chunks are the editions case's, so a fall-through to Vite's default 8
// would measure them instead of refusing.
export default ({ mode }) => ({
  build: {
    outDir: mode === 'web' ? '../editions/web-out' : '../editions/desktop-out',
    rolldownOptions: { output: { chunkFileNames: mode === 'web' ? 'assets/[name]-[hash:16].js' : 'assets/[name].js' } },
  },
});
