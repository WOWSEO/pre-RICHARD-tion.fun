import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Solana web3.js still touches Buffer in the browser. We expose `globalThis.Buffer`
// via a tiny shim entry; cleaner than vite-plugin-node-polyfills for our needs.
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: {
      // ensure a single React copy across wallet-adapter packages
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    include: [
      "buffer",
      "@solana/web3.js",
      "@solana/wallet-adapter-react",
      "@solana/wallet-adapter-react-ui",
      "@solana/wallet-adapter-wallets",
    ],
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          solana: [
            "@solana/web3.js",
            "@solana/wallet-adapter-base",
            "@solana/wallet-adapter-react",
            "@solana/wallet-adapter-react-ui",
            "@solana/wallet-adapter-wallets",
          ],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Forward /api/* to the Express server during dev. Set VITE_API_BASE_URL
      // to override (e.g. when client + server are deployed to different hosts).
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
