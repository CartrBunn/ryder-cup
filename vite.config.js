import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages the site is served from https://<user>.github.io/<repo>/,
// so the base must match the repo name. Override with VITE_BASE if you rename it.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/ryder-cup/'
});
