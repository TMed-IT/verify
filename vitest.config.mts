import { readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{
    name: "html-template",
    enforce: "pre",
    async load(id) {
      if (id.endsWith(".html")) {
        return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
      }
    },
  }, cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: { bindings: {
      ...JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8")).vars,
      TEST_SCHEMA: await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
      PUBLIC_ORIGIN: "http://localhost:3000",
      AUTH_EMAIL_ALLOW_REGEX: "^[^@]+@example\\.org$",
      HMAC_SECRET: "test-only-persistent-hmac-secret-for-vitest",
    } },
  }))],
  test: { setupFiles: ["./tests/setup.ts"], fileParallelism: false },
});
