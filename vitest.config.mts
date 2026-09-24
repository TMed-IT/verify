import { readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: { bindings: {
      TEST_SCHEMA: await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
      PUBLIC_ORIGIN: "http://localhost:3000",
      AUTH_EMAIL_ALLOW_REGEX: "^[^@]+@example\\.org$",
      HMAC_SECRET: "test-only-persistent-hmac-secret-for-vitest",
    } },
  }))],
  test: { setupFiles: ["./tests/setup.ts"], fileParallelism: false },
});
