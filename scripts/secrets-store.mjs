import { randomBytes } from "node:crypto";
import siteConfig from "../src/config.mjs";

export const clientSecretNames = Object.values(siteConfig.clients).map((client) => client.secret);
const storeName = "verify";
const idPattern = /^[0-9a-f]{32}$/i;

export async function ensureClientSecrets({ accountId, apiToken, fetchImpl = fetch, randomBytesImpl = randomBytes, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!idPattern.test(accountId ?? "") || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID または CLOUDFLARE_API_TOKEN が未設定です");
  }

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores`;
  async function request(path, method = "GET", body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Cloudflare のエラー本文を例外やログへ出すと機密値が混入し得る。
    if (!response.ok) throw new Error(`Secrets Store API ${method} が失敗しました (HTTP ${response.status})`);
    let data;
    try { data = await response.json(); } catch { throw new Error("Secrets Store API の応答が JSON ではありません"); }
    if (data?.success !== true) throw new Error(`Secrets Store API ${method} が失敗しました`);
    return data;
  }

  async function list(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const data = await request(`${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`);
      if (!Array.isArray(data.result)) throw new Error("Secrets Store API の一覧応答が不正です");
      all.push(...data.result);
      if (data.result_info?.total_pages != null) {
        if (page >= data.result_info.total_pages) break;
      } else if (data.result.length < 100) break;
      if (page >= 1000) throw new Error("Secrets Store API のページ数が多すぎます");
    }
    return all;
  }

  function selectStore(stores) {
    if (stores.length === 1) return stores[0];
    const named = stores.filter((item) => item.name === storeName);
    if (named.length > 1) throw new Error(`${storeName} という Secrets Store が複数あります`);
    if (stores.length > 1 && named.length === 0) {
      throw new Error(`Secrets Store が複数あり選択できません。使用する Store の名前を ${storeName} にしてください`);
    }
    return named[0] ?? null;
  }

  let store = selectStore(await list(""));
  if (!store) {
    try {
      store = (await request("", "POST", { name: storeName })).result;
    } catch (error) {
      // 同時配備で先に作成された可能性だけを再確認する。
      store = selectStore(await list(""));
      if (!store) throw error;
    }
  }
  if (!idPattern.test(store?.id ?? "")) throw new Error("Secrets Store の ID が不正です");

  const secretPath = `/${store.id}/secrets`;
  const existing = await list(secretPath);
  for (const secret of existing.filter((item) => clientSecretNames.includes(item.name))) {
    if (secret.status === "deleted" || !Array.isArray(secret.scopes) || !secret.scopes.includes("workers")) {
      throw new Error(`${secret.name} は使用可能な workers scope の secret ではありません`);
    }
  }
  for (const name of clientSecretNames) {
    let secret = existing.find((item) => item.name === name);
    if (!secret) {
      const value = randomBytesImpl(48).toString("base64url");
      try {
        await request(secretPath, "POST", [{ name, value, scopes: ["workers"] }]);
        secret = { name, scopes: ["workers"], status: "pending" };
      } catch (error) {
        // 同時配備で同名 secret が先に作成された場合はその値を維持する。
        secret = (await list(secretPath)).find((item) => item.name === name);
        if (!secret) throw error;
      }
    }
    if (secret.status === "deleted" || !Array.isArray(secret.scopes) || !secret.scopes.includes("workers")) {
      throw new Error(`${name} は使用可能な workers scope の secret ではありません`);
    }
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const current = await list(secretPath);
    for (const name of clientSecretNames) {
      const secret = current.find((item) => item.name === name);
      if (secret?.status === "deleted" || (secret && !secret.scopes?.includes("workers"))) {
        throw new Error(`${name} は使用可能な workers scope の secret ではありません`);
      }
    }
    if (clientSecretNames.every((name) => current.some((item) => item.name === name && item.status === "active"))) {
      return store.id;
    }
    if (attempt < 15) await sleepImpl(2000);
  }
  throw new Error("Secrets Store の client secret が30秒以内に有効になりませんでした");
}
