import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5000;

const basePath = process.env.BASE_PATH ?? "/";

// On Replit: default 8080 (Backend API workflow uses PORT=8080)
// On VPS / home server: set API_URL=http://localhost:4001
const apiTarget = process.env.API_URL ?? (process.env.REPL_ID ? "http://localhost:8080" : "http://localhost:4001");

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-runtime-error-modal").then((m) =>
            m.default()
          ),
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // React core — always needed, cached aggressively
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "vendor-react";
          }
          // Data fetching & routing — shared by all pages
          if (id.includes("node_modules/@tanstack/") || id.includes("node_modules/wouter")) {
            return "vendor-query";
          }
          // Radix UI components — shared UI primitives
          if (id.includes("node_modules/@radix-ui/")) {
            return "vendor-ui";
          }
          // Charting — heavy, only needed on chart pages
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) {
            return "vendor-charts";
          }
          // Icons — used across many pages
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-icons";
          }
          // Animation
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          // Decimal.js + other utilities
          if (id.includes("node_modules/decimal.js") || id.includes("node_modules/date-fns")) {
            return "vendor-utils";
          }
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: true,
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: true,
    allowedHosts: true,
  },
});
