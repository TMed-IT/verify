import assert from "node:assert/strict";
import test from "node:test";
import { ensureClientSecrets, clientSecretNames } from "../scripts/secrets-store.mjs";

const accountId = "a".repeat(32);
const storeId = "b".repeat(32);
const credentials = { accountId, apiToken: "test-token" };
const ok = (result) => new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }), {
  headers: { "Content-Type": "application/json" },
});

test("不足した Store と client secret だけを作り、既存値を維持する", async () => {
  let store = null;
  const secrets = new Map();
  const created = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer test-token");
    const path = new URL(url).pathname;
    if (path.endsWith("/stores")) {
      if (options.method === "GET") return ok(store ? [{ id: storeId, name: "verify" }] : []);
      assert.deepEqual(JSON.parse(options.body), { name: "verify" });
      store = storeId;
      return ok({ id: storeId });
    }
    assert.ok(path.endsWith(`/${storeId}/secrets`));
    if (options.method === "GET") return ok([...secrets.entries()].map(([name]) => ({ name, status: "active", scopes: ["workers"] })));
    const [entry] = JSON.parse(options.body);
    assert.deepEqual(entry.scopes, ["workers"]);
    assert.match(entry.value, /^[A-Za-z0-9_-]{64}$/);
    secrets.set(entry.name, entry.value);
    created.push(entry.name);
    return ok([{ name: entry.name, scopes: ["workers"], status: "pending" }]);
  };

  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl }), storeId);
  assert.deepEqual(created, clientSecretNames);
  assert.equal(new Set(secrets.values()).size, 3);
  const original = new Map(secrets);
  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl }), storeId);
  assert.deepEqual(secrets, original);
  assert.equal(created.length, 3);
});

test("一覧取得エラーと workers scope 不足では新しい値を作らない", async () => {
  const failedFetch = async () => new Response("forbidden", { status: 403 });
  await assert.rejects(ensureClientSecrets({ ...credentials, fetchImpl: failedFetch }), /HTTP 403/);
  let posts = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") posts++;
    if (new URL(url).pathname.endsWith("/stores")) return ok([{ id: storeId, name: "verify" }]);
    return ok(clientSecretNames.map((name) => ({ name, status: "active", scopes: ["ai_gateway"] })));
  };
  await assert.rejects(ensureClientSecrets({ ...credentials, fetchImpl }), /workers scope/);
  assert.equal(posts, 0);
});

test("作成中の secret が有効になるまで待つ", async () => {
  let polls = 0;
  let sleeps = 0;
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith("/stores")) return ok([{ id: storeId, name: "verify" }]);
    assert.equal(options.method, "GET");
    polls++;
    return ok(clientSecretNames.map((name) => ({ name, status: polls >= 3 ? "active" : "pending", scopes: ["workers"] })));
  };
  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl, sleepImpl: async () => { sleeps++; } }), storeId);
  assert.equal(sleeps, 1);
});

test("複数 Store がある場合は対象名の Store を選ぶ", async () => {
  let writes = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") writes++;
    if (new URL(url).pathname.endsWith("/stores")) {
      return ok([{ id: "c".repeat(32), name: "unrelated" }, { id: storeId, name: "verify" }]);
    }
    assert.ok(new URL(url).pathname.endsWith(`/${storeId}/secrets`));
    return ok(clientSecretNames.map((name) => ({ name, status: "active", scopes: ["workers"] })));
  };
  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl }), storeId);
  assert.equal(writes, 0);
});

test("別名の既存 Store で MAIN の secret だけを作成し、既存値を維持する", async () => {
  const secrets = new Map([
    ["CLIENT_SECRET_ATND", "existing-atnd-secret"],
    ["CLIENT_SECRET_CS", "existing-cs-secret"],
  ]);
  const original = new Map(secrets);
  const created = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/stores")) {
      assert.equal(options.method, "GET");
      return ok([{ id: storeId, name: "existing-store" }]);
    }
    assert.ok(path.endsWith(`/${storeId}/secrets`));
    if (options.method === "GET") {
      return ok([...secrets.keys()].map((name) => ({ name, status: "active", scopes: ["workers"] })));
    }
    assert.equal(options.method, "POST");
    const [entry] = JSON.parse(options.body);
    assert.equal(entry.name, "CLIENT_SECRET_MAIN");
    assert.deepEqual(entry.scopes, ["workers"]);
    assert.match(entry.value, /^[A-Za-z0-9_-]{64}$/);
    secrets.set(entry.name, entry.value);
    created.push(entry.name);
    return ok([{ name: entry.name, scopes: ["workers"], status: "pending" }]);
  };
  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl }), storeId);
  assert.equal(await ensureClientSecrets({ ...credentials, fetchImpl }), storeId);
  assert.deepEqual(created, ["CLIENT_SECRET_MAIN"]);
  for (const [name, value] of original) assert.equal(secrets.get(name), value);
  assert.equal(secrets.size, 3);
});

test("複数の別名 Store がある場合は選択できず、書き込まない", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.ok(new URL(url).pathname.endsWith("/stores"));
    return ok([{ id: storeId, name: "first" }, { id: "c".repeat(32), name: "second" }]);
  };
  await assert.rejects(ensureClientSecrets({ ...credentials, fetchImpl }), /選択できません/);
});
