import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("本番ビルドで HTML テンプレートを読み込み、メール送信まで到達する", async () => {
  const { routeModule } = require("../.next/server/app/auth/request-link/route.js");
  const browser = "b".repeat(43);
  const flow = "f".repeat(43);
  const pending = [];
  const sent = [];
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const env = {
    ...config.vars,
    EMAIL_FROM: config.send_email[0].allowed_sender_addresses[0],
    AUTH_EMAIL_ALLOW_REGEX: "^[^@]+@example\\.org$",
    HMAC_SECRET: "test-only-persistent-hmac-secret-for-build",
    REQUEST_LINK_IP: { limit: async () => ({ success: true }) },
    REQUEST_LINK_BROWSER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(query) {
        return {
          bind() { return this; },
          async first() {
            if (query.startsWith("SELECT * FROM flows")) return { id: flow, browser_hash: createHash("sha256").update(browser).digest("base64url") };
            if (query.startsWith("INSERT INTO rate_limits")) return { count: 1 };
            if (query.startsWith("UPDATE flows")) return { id: flow };
            throw new Error("unexpected query");
          },
          async run() { return { success: true }; },
        };
      },
    },
    EMAIL: { async send(message) { sent.push(message); return { messageId: "test" }; } },
  };
  const contextKey = Symbol.for("__cloudflare-context__");
  const previous = globalThis[contextKey];
  globalThis[contextKey] = { env, ctx: { waitUntil(promise) { pending.push(promise); } } };
  try {
    const response = await routeModule.userland.POST(new Request(`${env.PUBLIC_ORIGIN}/auth/request-link`, {
      method: "POST",
      headers: { Origin: env.PUBLIC_ORIGIN, Cookie: `__Host-browser=${browser}`, "Content-Type": "application/json" },
      body: JSON.stringify({ flow, email: "student@example.org" }),
    }));
    await Promise.all(pending);
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1, "HTML の読み込みに失敗して送信処理に到達していません");
    assert.equal(sent[0].from, env.EMAIL_FROM);
    assert.match(sent[0].html, /<!doctype html>/i);
    assert.ok(!sent[0].html.includes("{{"));
    const link = new URL(sent[0].text.match(/https:\/\/[^\s]+/)[0]);
    assert.equal(link.searchParams.get("flow"), flow);
    assert.ok(link.hash.startsWith("#token="));
    assert.ok(sent[0].html.includes(`href="${link.href}"`));
  } finally {
    if (previous === undefined) delete globalThis[contextKey];
    else globalThis[contextKey] = previous;
  }
});
