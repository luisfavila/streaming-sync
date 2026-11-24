import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built page works at any address: a domain's root, or a
  // sub-path like GitHub Pages' https://you.github.io/streaming-sync/.
  base: './',
  build: {
    rollupOptions: {
      // The app, and the privacy policy beside it (privacy.html).
      input: { main: 'index.html', privacy: 'privacy.html' },
    },
  },
});
