import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async (): Promise<UserConfig> => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "editor",
              test: /node_modules[\\/]@tiptap[\\/]/,
              priority: 30,
              minSize: 1,
            },
            {
              name: "motion",
              test: /node_modules[\\/](motion|gsap)[\\/]/,
              priority: 20,
              minSize: 1,
            },
            {
              name: "vendor",
              test: /node_modules[\\/](react|react-dom|@tanstack[\\/]react-query|i18next|react-i18next)[\\/]/,
              priority: 10,
              minSize: 1,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
