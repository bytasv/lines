import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // VITE_* vars load from the repo-root .env (shared with the bridge).
  envDir: '..',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
});
