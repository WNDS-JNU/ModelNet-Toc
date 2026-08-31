import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { honoServerDedupe, honoServerPlugins } from './viteNodeServer.config';

const serverRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: fileURLToPath(new URL('./dist-agent-worker', import.meta.url)),
    rollupOptions: {
      input: fileURLToPath(new URL('./src/services/queue/agentWorkerEntry.ts', import.meta.url)),
      output: {
        codeSplitting: false,
        entryFileNames: 'agent-worker.mjs',
        format: 'es',
      },
    },
    ssr: true,
    target: 'node24',
  },
  plugins: honoServerPlugins(),
  resolve: {
    dedupe: honoServerDedupe,
  },
  root: serverRoot,
  ssr: {
    noExternal: true,
  },
});
