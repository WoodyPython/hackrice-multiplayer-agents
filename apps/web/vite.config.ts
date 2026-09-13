import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Workspace scripts run from apps/web; the documented .env lives at root.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [tailwindcss()],
  // y-monaco still imports the pre-0.56 path; Monaco now exports paths below vs.
  resolve: { alias: { "monaco-editor/esm/vs/editor/editor.api.js": "monaco-editor/editor/editor.api.js" } },
  server: { proxy: { "/api": "http://127.0.0.1:3000", "/live": { target: "ws://127.0.0.1:3000", ws: true } } },
  preview: { proxy: { "/api": "http://127.0.0.1:3000", "/live": { target: "ws://127.0.0.1:3000", ws: true } } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], fileParallelism: false },
});
