import { defineConfig } from 'vite';

/** Builds the Android bridge as one classic script that runs before the POS module loads. */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: 'src/bridge.ts',
      name: 'MezonAndroidBridge',
      formats: ['iife'],
      fileName: () => 'android-bridge.js',
    },
  },
});
