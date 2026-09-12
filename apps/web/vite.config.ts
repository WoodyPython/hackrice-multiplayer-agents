import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  preview: { proxy: { "/api": "http://127.0.0.1:3000" } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], fileParallelism: false },
});
