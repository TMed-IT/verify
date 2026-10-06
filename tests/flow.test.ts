import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { hmac, IDLE_SECONDS, LINK_SECONDS, MAX_SECONDS, randomToken, sha256 } from "../src/policy";
import worker from "../src/server/auth";

const base = env.PUBLIC_ORIGIN;
const origin = { Origin: base };
const verifier = "v".repeat(43);
const state = "s".repeat(32);
const testSecrets = {
  CLIENT_SECRET_MAIN: "test-client-secret-main-32-bytes-or-more",
  CLIENT_SECRET_ATND: "test-client-secret-atnd-32-bytes-or-more",
  CLIENT_SECRET_CS: "test-client-secret-cs-32-bytes-or-more",
};
const testEnv = {
  ...env,
  CLIENT_SECRET_MAIN: { get: async () => testSecrets.CLIENT_SECRET_MAIN },
  CLIENT_SECRET_ATND: { get: async () => testSecrets.CLIENT_SECRET_ATND },
  CLIENT_SECRET_CS: { get: async () => testSecrets.CLIENT_SECRET_CS },
  FLOW_START_IP: { limit: async () => ({ success: true }) },
  FLOW_START_BROWSER: { limit: async () => ({ success: true }) },
  REQUEST_LINK_IP: { limit: async () => ({ success: true }) },
  REQUEST_LINK_BROWSER: { limit: async () => ({ success: true }) },
} as Env;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${base}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function post(path: string, value: object, browserCookie = ""): Promise<Response> {
  return call(path, { method: "POST", headers: { ...origin, "Content-Type": "application/json", Cookie: browserCookie }, body: JSON.stringify(value) });
}
async function begin(client = "tmedit", challenge?: string): Promise<{ flow: string; cookie: string }> {
  const actualChallenge = challenge || await sha256(verifier);
  const query = new URLSearchParams({ client_id: client, redirect_uri: `https://${client === "tmedit" ? "tmedit.org" : `${client}.tmedit.org`}/auth/verify/callback`, state, code_challenge: actualChallenge, code_challenge_method: "S256" });
  const response = await call(`/auth/authorize?${query}`);
  expect(response.status).toBe(303);
  return { flow: new URL(response.headers.get("Location")!, base).searchParams.get("flow")!, cookie: response.headers.get("Set-Cookie")!.split(";")[0] };
}
async function seedLink(flow: string, token = randomToken(), offset = LINK_SECONDS, email = "alice@example.org"): Promise<string> {
  const emailKey = await hmac(env.HMAC_SECRET, "email", email);
  await env.DB.prepare("INSERT INTO magic_links(token_hash,flow_id,email_key,expires_at) VALUES(?,?,?,?)")
    .bind(await sha256(token), flow, emailKey, Math.floor(Date.now() / 1000) + offset).run();
  return token;
}
async function verify(flow: string, browserCookie: string, token: string): Promise<{ response: Response; data: { redirect?: string; error?: string } }> {
  const response = await post("/auth/confirm", { flow, token }, browserCookie);
  return { response, data: await response.json() };
}
async function linkStatus(flow: string, token: string, browserCookie = ""): Promise<{ status: string }> {
  const response = await post("/auth/link/status", { flow, token }, browserCookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json();
}
async function tokenFor(code: string, client = "tmedit", codeVerifier = verifier): Promise<{ response: Response; data: { access_token?: string; expires_in?: number; error?: string } }> {
  const secretName = client === "tmedit" ? "CLIENT_SECRET_MAIN" : client === "atnd" ? "CLIENT_SECRET_ATND" : "CLIENT_SECRET_CS";
  const response = await post("/auth/token", { client_id: client, client_secret: testSecrets[secretName], code, code_verifier: codeVerifier, redirect_uri: `https://${client === "tmedit" ? "tmedit.org" : `${client}.tmedit.org`}/auth/verify/callback` });
  return { response, data: await response.json() };
}
async function introspect(token: string, client = "tmedit"): Promise<{ active: boolean }> {
  const secretName = client === "tmedit" ? "CLIENT_SECRET_MAIN" : client === "atnd" ? "CLIENT_SECRET_ATND" : "CLIENT_SECRET_CS";
  const response = await post("/auth/introspect", { client_id: client, client_secret: testSecrets[secretName], token });
  return response.json();
}

describe("メールリンクと認可コード", () => {
  it("フロー開始の IP 制限では D1 に書き込まず 429 を返す", async () => {
    const ipLimit = vi.fn(async () => ({ success: false }));
    const browserLimit = vi.fn(async () => ({ success: true }));
    const limitedEnv = { ...testEnv, FLOW_START_IP: { limit: ipLimit }, FLOW_START_BROWSER: { limit: browserLimit } } as Env;
    const query = new URLSearchParams({
      client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const count = async (table: "flows" | "rate_limits") =>
      (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const before = [await count("flows"), await count("rate_limits")];

    for (const path of ["/", `/auth/authorize?${query}`]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${base}${path}`, {
        headers: { "CF-Connecting-IP": "192.0.2.10" },
      }), limitedEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(ipLimit).toHaveBeenCalledTimes(2);
    expect(ipLimit).toHaveBeenCalledWith({ key: await hmac(env.HMAC_SECRET, "flow-ip", "192.0.2.10") });
    expect(browserLimit).not.toHaveBeenCalled();
    expect([await count("flows"), await count("rate_limits")]).toEqual(before);
  });

  it("同じブラウザの開始制限では新しいフローを作らない", async () => {
    const { cookie } = await begin();
    const browserLimit = vi.fn(async () => ({ success: false }));
    const limitedEnv = { ...testEnv, FLOW_START_BROWSER: { limit: browserLimit } } as Env;
    const before = (await env.DB.prepare("SELECT count(*) AS n FROM flows").first<{ n: number }>())!.n;
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${base}/`, { headers: { Cookie: cookie } }), limitedEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(429);
    expect(browserLimit).toHaveBeenCalledWith({ key: await sha256(cookie.split("=")[1]) });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM flows").first<{ n: number }>())!.n).toBe(before);
  });

  it("Email Sending binding にフラグメント付きリンクを渡し、上限後は送らない", async () => {
    const { flow, cookie } = await begin();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE flows SET created_at=?,expires_at=? WHERE id=?").bind(now - 14 * 60, now + 60, flow).run();
    const send = vi.fn(async (_message: { to: string; from: string; text: string; html: string }) => ({ messageId: "test" }));
    const fakeEnv = { ...testEnv, EMAIL: { send } } as Env;
    const results: string[] = [];
    for (let index = 0; index < 4; index++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${base}/auth/request-link`, {
        method: "POST", headers: { ...origin, Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
        body: JSON.stringify({ flow, email: " Alice@Example.org " }),
      }), fakeEnv, ctx);
      results.push(await response.text());
      await waitOnExecutionContext(ctx);
    }
    expect(new Set(results).size).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    const sent = send.mock.calls[0][0];
    expect(sent.to).toBe("alice@example.org");
    expect(sent.from).toBe("noreply@verify.tmedit.org");
    expect(sent.text).toMatch(/\/link\?flow=[A-Za-z0-9_-]+#token=[A-Za-z0-9_-]+/);
    const textLink = sent.text.match(/https?:\/\/\S+\/link\?flow=[A-Za-z0-9_-]+#token=[A-Za-z0-9_-]+/)![0];
    expect(sent.html).toContain(`href="${textLink}"`);
    const extended = await env.DB.prepare("SELECT expires_at FROM flows WHERE id=?").bind(flow).first<{ expires_at: number }>();
    const linkExpiry = await env.DB.prepare("SELECT MAX(expires_at) AS expires_at FROM magic_links WHERE flow_id=?").bind(flow).first<{ expires_at: number }>();
    expect(extended?.expires_at).toBeGreaterThanOrEqual(now + LINK_SECONDS);
    expect(extended!.expires_at).toBeGreaterThanOrEqual(linkExpiry!.expires_at);
    expect(linkExpiry!.expires_at).toBeLessThanOrEqual(now + LINK_SECONDS + 5);

    // 延長されたフローでも、開始から15分を過ぎた新規送信は受け付けない。
    await env.DB.prepare("UPDATE flows SET created_at=? WHERE id=?").bind(now - 16 * 60, flow).run();
    const ctx = createExecutionContext();
    await worker.fetch(new Request(`${base}/auth/request-link`, {
      method: "POST", headers: { ...origin, Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
      body: JSON.stringify({ flow, email: "bob@example.org" }),
    }), fakeEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("対象外メールでも同じ応答を返す", async () => {
    const { flow, cookie } = await begin();
    const outside = await post("/auth/request-link", { flow, email: "not-allowed@other.org" }, cookie);
    const malformed = await post("/auth/request-link", { flow, email: "invalid" }, cookie);
    expect(outside.status).toBe(200);
    expect(await outside.json()).toEqual(await malformed.json());
  });

  it.each(["IP", "ブラウザ"] as const)("送信要求の%s制限を超えた場合は D1 にアクセスしない", async (kind) => {
    const { flow, cookie } = await begin();
    const denied = vi.fn(async () => ({ success: false }));
    const prepare = vi.fn((query: string) => env.DB.prepare(query));
    const database: D1Database = {
      prepare,
      batch: env.DB.batch.bind(env.DB),
      exec: env.DB.exec.bind(env.DB),
      withSession: env.DB.withSession.bind(env.DB),
      dump: env.DB.dump.bind(env.DB),
    };
    const send = vi.fn(async () => ({ messageId: "test" }));
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${base}/auth/request-link`, {
      method: "POST", headers: { ...origin, Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.2" },
      body: JSON.stringify({ flow, email: "alice@example.org" }),
    }), { ...testEnv, DB: database, EMAIL: { send },
      [kind === "IP" ? "REQUEST_LINK_IP" : "REQUEST_LINK_BROWSER"]: { limit: denied },
    } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(denied).toHaveBeenCalledWith({ key: kind === "IP"
      ? await hmac(env.HMAC_SECRET, "ip", "192.0.2.2") : await sha256(cookie.split("=")[1]) });
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("共有 IP から10回を超えて送信でき、メールの上限はブラウザ間で共有する", async () => {
    const ip = "192.0.2.3";
    const send = vi.fn(async () => ({ messageId: "test" }));
    const fakeEnv = { ...testEnv, EMAIL: { send } } as Env;
    for (let index = 0; index < 12; index++) {
      const ctx = createExecutionContext();
      const started = await worker.fetch(new Request(`${base}/`, {
        headers: { "CF-Connecting-IP": ip },
      }), fakeEnv, ctx);
      expect(started.status).toBe(303);
      const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
      const cookie = started.headers.get("Set-Cookie")!.split(";")[0];
      const email = index < 3 || index === 11 ? "shared@example.org" : `student${index}@example.org`;
      const response = await worker.fetch(new Request(`${base}/auth/request-link`, {
        method: "POST", headers: { ...origin, Cookie: cookie, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ flow, email }),
      }), fakeEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(await response.json()).toEqual({ ok: true });
      expect(send).toHaveBeenCalledTimes(Math.min(index + 1, 11));
    }
    const buckets = (await env.DB.prepare("SELECT bucket_key,count FROM rate_limits").all<{ bucket_key: string; count: number }>()).results;
    const sharedEmailKey = `email:${await hmac(env.HMAC_SECRET, "email", "shared@example.org")}`;
    expect(buckets.every(bucket => bucket.bucket_key.startsWith("email:"))).toBe(true);
    expect(buckets.find(bucket => bucket.bucket_key === sharedEmailKey)?.count).toBe(3);
  });

  it("別ブラウザでは未消費、元のブラウザでは一度だけ確認できる", async () => {
    const { flow, cookie } = await begin();
    const expiredToken = await seedLink(flow, randomToken(), -1);
    expect(await linkStatus(flow, expiredToken, cookie)).toEqual({ status: "invalid" });
    expect((await verify(flow, cookie, expiredToken)).response.status).toBe(400);
    const token = await seedLink(flow);
    expect(await linkStatus(flow, token, cookie)).toEqual({ status: "ready" });
    expect(await linkStatus(flow, token)).toEqual({ status: "other_browser" });
    const wrong = await verify(flow, "", token);
    expect(wrong.response.status).toBe(409);
    expect(await linkStatus(flow, token, cookie)).toEqual({ status: "ready" });
    const first = await verify(flow, cookie, token);
    expect(first.response.status).toBe(200);
    expect(await linkStatus(flow, token, cookie)).toEqual({ status: "invalid" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM magic_links").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM flows").first<{ n: number }>())?.n).toBe(0);
    expect(first.response.headers.getSetCookie().every(value => value.includes("HttpOnly; Secure; SameSite=Lax"))).toBe(true);
    expect(new URL(first.data.redirect!).searchParams.get("state")).toBe(state);
    const reused = await verify(flow, cookie, token);
    expect(reused.response.status).toBe(409);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  it("同じフローの2リンクを同時確認しても成功したコードを交換できる", async () => {
    const { flow, cookie } = await begin();
    const links = [await seedLink(flow), await seedLink(flow)];
    const results = await Promise.all(links.map(token => verify(flow, cookie, token)));
    expect(results.map(result => result.response.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.response.status === 200)!;
    const code = new URL(winner.data.redirect!).searchParams.get("code")!;
    const exchanged = await tokenFor(code);
    expect(exchanged.response.status).toBe(200);
    expect(await introspect(exchanged.data.access_token!)).toEqual({ active: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
  });

  it.each(["alice@example.org", "bob@example.org"])("同じブラウザの別フロー同時確認（%s）は一方だけ成功する", async (email) => {
    const first = await begin();
    const query = new URLSearchParams({ client_id: "atnd", redirect_uri: "https://atnd.tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256" });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: first.cookie } });
    const secondFlow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const flows = [first.flow, secondFlow];
    const links = [await seedLink(first.flow), await seedLink(secondFlow, randomToken(), LINK_SECONDS, email)];
    // Both requests must finish their reads before either confirmation transaction runs.
    let entered = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const database = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (++entered === 2) release();
        await ready;
        return env.DB.batch(statements);
      },
    } as D1Database;
    const responses = await Promise.all(flows.map(async (flow, i) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${base}/auth/confirm`, {
        method: "POST", headers: { ...origin, Cookie: first.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ flow, token: links[i] }),
      }), { ...testEnv, DB: database }, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    }));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.status === 200);
    expect(responses[1 - winner].headers.get("Set-Cookie")).toBeNull();
    const sessionCookie = responses[winner].headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    expect(await (await call("/me", { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } })).json())
      .toEqual({ authenticated: true });
    const data = await responses[winner].json() as { redirect: string };
    const client = winner === 0 ? "tmedit" : "atnd";
    const exchanged = await tokenFor(new URL(data.redirect).searchParams.get("code")!, client);
    expect(exchanged.response.status).toBe(200);
    expect(await introspect(exchanged.data.access_token!, client)).toEqual({ active: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM flows").first<{ n: number }>())?.n).toBe(0);
  });

  it("確認と既存セッションからの継続が競合しても成功したコードは有効", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const sessionCookie = confirmed.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const query = new URLSearchParams({
      client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } });
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const link = await seedLink(flow);
    const [continued, reconfirmed] = await Promise.all([
      post("/auth/continue", { flow }, `${first.cookie}; ${sessionCookie}`),
      verify(flow, first.cookie, link),
    ]);
    const continueData = await continued.json() as { redirect?: string };
    const successful = [continued.status === 200 ? continueData.redirect : null, reconfirmed.response.status === 200 ? reconfirmed.data.redirect : null].filter(Boolean);
    expect(successful).toHaveLength(1);
    const code = new URL(successful[0]!).searchParams.get("code")!;
    const exchanged = await tokenFor(code);
    expect(exchanged.response.status).toBe(200);
    expect(await introspect(exchanged.data.access_token!)).toEqual({ active: true });
  });

  it("コード作成に失敗してもリンクと旧セッションを保持し、同じリンクで再試行できる", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const oldCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const oldToken = (await tokenFor(oldCode)).data.access_token!;
    const query = new URLSearchParams({
      client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: first.cookie } });
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const link = await seedLink(flow);

    await env.DB.exec("CREATE TRIGGER fail_code BEFORE INSERT ON auth_codes BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    let failed: Response;
    try {
      failed = (await verify(flow, first.cookie, link)).response;
    } finally {
      await env.DB.exec("DROP TRIGGER fail_code");
    }
    expect(failed.status).toBe(500);
    expect(await introspect(oldToken)).toEqual({ active: true });
    expect(await linkStatus(flow, link, first.cookie)).toEqual({ status: "ready" });

    const retried = await verify(flow, first.cookie, link);
    expect(retried.response.status).toBe(200);
    expect(await introspect(oldToken)).toEqual({ active: false });
  });

  it("確認中にフローが期限切れになっても旧セッションを失効させない", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const oldCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const oldToken = (await tokenFor(oldCode)).data.access_token!;
    const query = new URLSearchParams({
      client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: first.cookie } });
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const link = await seedLink(flow);
    const database = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE flows SET expires_at=? WHERE id=?")
          .bind(Math.floor(Date.now() / 1000) - 1, flow).run();
        return env.DB.batch(statements);
      },
    } as D1Database;
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${base}/auth/confirm`, {
      method: "POST", headers: { ...origin, "Content-Type": "application/json", Cookie: first.cookie },
      body: JSON.stringify({ flow, token: link }),
    }), { ...testEnv, DB: database }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
    expect(await introspect(oldToken)).toEqual({ active: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM magic_links WHERE token_hash=?")
      .bind(await sha256(link)).first<{ n: number }>())?.n).toBe(1);
  });

  it("既存セッションからのコード発行も途中失敗後に再試行できる", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const sessionCookie = confirmed.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const query = new URLSearchParams({
      client_id: "atnd", redirect_uri: "https://atnd.tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } });
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    await env.DB.exec("CREATE TRIGGER fail_code BEFORE INSERT ON auth_codes BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    let failed: Response;
    try {
      failed = await post("/auth/continue", { flow }, `${first.cookie}; ${sessionCookie}`);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_code");
    }
    expect(failed.status).toBe(500);
    const retried = await post("/auth/continue", { flow }, `${first.cookie}; ${sessionCookie}`);
    expect(retried.status).toBe(200);
    const code = new URL((await retried.json() as { redirect: string }).redirect).searchParams.get("code")!;
    expect((await tokenFor(code, "atnd")).response.status).toBe(200);
  });

  it("フローが期限切れなら別ブラウザでも期限切れを返す", async () => {
    const { flow, cookie } = await begin();
    const token = await seedLink(flow);
    await env.DB.prepare("UPDATE flows SET expires_at=? WHERE id=?")
      .bind(Math.floor(Date.now() / 1000) - 1, flow).run();
    expect(await linkStatus(flow, token, cookie)).toEqual({ status: "invalid" });
    expect(await linkStatus(flow, token)).toEqual({ status: "invalid" });
  });

  it("同じブラウザで再確認してもセッション枠を増やさない", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const oldCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const oldToken = (await tokenFor(oldCode)).data.access_token!;
    const sessionCookie = confirmed.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const query = new URLSearchParams({ client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback", state, code_challenge: await sha256(verifier), code_challenge_method: "S256" });
    const again = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } });
    const flow = new URL(again.headers.get("Location")!, base).searchParams.get("flow")!;
    const reconfirmed = await verify(flow, `${first.cookie}; ${sessionCookie}`, await seedLink(flow));
    expect(reconfirmed.response.status).toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
    expect(await introspect(oldToken)).toEqual({ active: false });
    const newCode = new URL(reconfirmed.data.redirect!).searchParams.get("code")!;
    const newToken = (await tokenFor(newCode)).data.access_token!;
    expect(await introspect(newToken)).toEqual({ active: true });
  });

  it("セッション Cookie がなくても同じブラウザの旧メールを失効させる", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const oldCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const oldToken = (await tokenFor(oldCode)).data.access_token!;

    const query = new URLSearchParams({
      client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback",
      state, code_challenge: await sha256(verifier), code_challenge_method: "S256",
    });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: first.cookie } });
    expect(started.headers.get("Set-Cookie")).toBeNull();
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const newLink = await seedLink(flow, randomToken(), LINK_SECONDS, "bob@example.org");
    const switched = await verify(flow, first.cookie, newLink);
    expect(switched.response.status).toBe(200);
    expect(await introspect(oldToken)).toEqual({ active: false });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM client_tokens WHERE token_hash=?")
      .bind(await sha256(oldToken)).first<{ n: number }>())?.n).toBe(0);

    const newCode = new URL(switched.data.redirect!).searchParams.get("code")!;
    const newToken = (await tokenFor(newCode)).data.access_token!;
    expect(await introspect(newToken)).toEqual({ active: true });
    const browserHash = await sha256(first.cookie.split("=")[1]);
    const sessions = await env.DB.prepare("SELECT email_key FROM sessions WHERE browser_hash=?")
      .bind(browserHash).all<{ email_key: string }>();
    expect(sessions.results).toEqual([{ email_key: await hmac(env.HMAC_SECRET, "email", "bob@example.org") }]);
  });

  it("state を返し、PKCE、コード再利用、連携先別トークン、ログアウトを確認する", async () => {
    const invalid = new URLSearchParams({ client_id: "tmedit", redirect_uri: "https://evil.example/auth/verify/callback", state, code_challenge: await sha256(verifier), code_challenge_method: "S256" });
    expect((await call(`/auth/authorize?${invalid}`)).status).toBe(400);
    const one = await begin();
    const link = await seedLink(one.flow);
    const result = await verify(one.flow, one.cookie, link);
    const sessionCookie = result.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const code = new URL(result.data.redirect!).searchParams.get("code")!;
    expect((await tokenFor(code, "tmedit", "x".repeat(43))).response.status).toBe(400);
    expect((await tokenFor(code, "atnd")).response.status).toBe(400);
    const first = await tokenFor(code);
    expect(first.response.status).toBe(200);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_codes").first<{ n: number }>())?.n).toBe(0);
    expect((await tokenFor(code)).response.status).toBe(400);
    expect(await introspect(first.data.access_token!)).toEqual({ active: true });
    expect(await introspect(first.data.access_token!, "atnd")).toEqual({ active: false });

    const challenge = await sha256(verifier);
    const query = new URLSearchParams({ client_id: "atnd", redirect_uri: "https://atnd.tmedit.org/auth/verify/callback", state, code_challenge: challenge, code_challenge_method: "S256" });
    const sameBrowser = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${one.cookie}; ${sessionCookie}` } });
    const nextFlow = new URL(sameBrowser.headers.get("Location")!, base).searchParams.get("flow")!;
    const continued = await post("/auth/continue", { flow: nextFlow }, `${one.cookie}; ${sessionCookie}`);
    const secondCode = new URL((await continued.json() as { redirect: string }).redirect).searchParams.get("code")!;
    const second = await tokenFor(secondCode, "atnd");
    expect(second.data.access_token).toBeTruthy();
    expect(second.data.access_token).not.toBe(first.data.access_token);
    expect(await introspect(second.data.access_token!, "atnd")).toEqual({ active: true });

    const logout = await call("/auth/logout", { method: "POST", headers: { Origin: "https://tmedit.org", "Content-Type": "application/json", Cookie: `${one.cookie}; ${sessionCookie}` }, body: "{}" });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Access-Control-Allow-Origin")).toBe("https://tmedit.org");
    expect(await introspect(first.data.access_token!)).toEqual({ active: false });
    expect(await introspect(second.data.access_token!, "atnd")).toEqual({ active: false });
  });

  it.each(["トークン作成", "コード消費"] as const)("交換中の%s失敗を rollback し、同じコードで再試行できる", async (stage) => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const event = stage === "トークン作成" ? "INSERT ON client_tokens" : "DELETE ON auth_codes";
    await env.DB.exec(`CREATE TRIGGER fail_exchange BEFORE ${event} BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    let failed: Awaited<ReturnType<typeof tokenFor>>;
    try {
      failed = await tokenFor(code);
    } finally {
      await env.DB.exec("DROP TRIGGER fail_exchange");
    }
    expect(failed.response.status).toBe(500);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_codes WHERE code_hash=?").bind(await sha256(code)).first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM client_tokens").first<{ n: number }>())?.n).toBe(0);
    const retried = await tokenFor(code);
    expect(retried.response.status).toBe(200);
    expect(await introspect(retried.data.access_token!)).toEqual({ active: true });
    expect((await tokenFor(code)).response.status).toBe(400);
  });

  it("同じコードを同時交換してもトークンを一度だけ発行する", async () => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const results = await Promise.all([tokenFor(code), tokenFor(code)]);
    expect(results.map(result => result.response.status).sort()).toEqual([200, 400]);
    const winner = results.find(result => result.response.status === 200)!;
    expect(await introspect(winner.data.access_token!)).toEqual({ active: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM client_tokens").first<{ n: number }>())?.n).toBe(1);
  });

  it("Secrets Store 障害は 500、不一致は認証エラーとして返しコードを消費しない", async () => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const values = { client_id: "tmedit", client_secret: testSecrets.CLIENT_SECRET_MAIN,
      code, code_verifier: verifier, redirect_uri: "https://tmedit.org/auth/verify/callback", token: randomToken() };
    const brokenEnv = { ...testEnv, CLIENT_SECRET_MAIN: { get: async () => { throw new Error("unavailable"); } } } as Env;
    for (const path of ["/auth/token", "/auth/introspect"]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${base}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      }), brokenEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      for (const invalidClient of [
        { client_secret: "incorrect-secret" },
        { client_secret: "" },
        { client_id: "unknown" },
      ]) {
        const rejected = await post(path, { ...values, ...invalidClient });
        expect(rejected.status).toBe(401);
        expect(await rejected.json()).toEqual({ error: "unauthorized_client" });
        expect(rejected.headers.get("Cache-Control")).toBe("no-store");
      }
    }
    expect((await tokenFor(code)).response.status).toBe(200);
  });

  it("セッション Cookie が消えてもブラウザ Cookie でログアウトを完了する", async () => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const token = (await tokenFor(code)).data.access_token!;
    expect(await introspect(token)).toEqual({ active: true });
    const response = await post("/auth/logout", {}, cookie);
    expect(response.status).toBe(200);
    expect(await introspect(token)).toEqual({ active: false });
  });
});

describe("ブラウザ数と期限", () => {
  it("失効済みセッションを除外して有効な3ブラウザを維持する", async () => {
    const activeTokens: string[] = [];
    for (let index = 0; index < 2; index++) {
      const { flow, cookie } = await begin();
      const confirmed = await verify(flow, cookie, await seedLink(flow));
      const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
      activeTokens.push((await tokenFor(code)).data.access_token!);
    }

    const now = Math.floor(Date.now() / 1000);
    const emailKey = await hmac(env.HMAC_SECRET, "email", "alice@example.org");
    await env.DB.prepare("UPDATE sessions SET last_seen=?").bind(now - 10).run();
    const expiredIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of expiredIds.entries()) {
      await env.DB.prepare("INSERT INTO sessions(id,email_key,browser_hash,session_hash,created_at,last_seen) VALUES(?,?,?,?,?,?)")
        .bind(id, emailKey, await sha256(randomToken()), await sha256(randomToken()),
          index === 0 ? now - MAX_SECONDS : now - IDLE_SECONDS - 10,
          index === 0 ? now : now - IDLE_SECONDS).run();
    }

    const next = await begin();
    const confirmed = await verify(next.flow, next.cookie, await seedLink(next.flow));
    expect(confirmed.response.status).toBe(200);
    for (const token of activeTokens) expect(await introspect(token)).toEqual({ active: true });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(3);
    for (const id of expiredIds) {
      expect(await env.DB.prepare("SELECT id FROM sessions WHERE id=?").bind(id).first()).toBeNull();
    }
  });

  it("古いセッションで交換したトークンには90日上限までの残り時間を返す", async () => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE sessions SET created_at=?").bind(now - MAX_SECONDS + 86400).run();
    const exchanged = await tokenFor(code);
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.data.expires_in).toBeGreaterThanOrEqual(86400 - 5);
    expect(exchanged.data.expires_in).toBeLessThanOrEqual(86400);
    expect(await introspect(exchanged.data.access_token!)).toEqual({ active: true });
  });

  it("同時に4台が確認しても有効なセッションは3台以下", async () => {
    const starts = await Promise.all(Array.from({ length: 4 }, () => begin()));
    const links = await Promise.all(starts.map(item => seedLink(item.flow)));
    const confirms = await Promise.all(starts.map((item, index) => verify(item.flow, item.cookie, links[index])));
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>();
    expect(sessions?.n).toBe(3);
    expect(confirms.every(result => [200, 409].includes(result.response.status))).toBe(true);
    const issued = confirms.filter(result => result.data.redirect);
    for (const result of issued) {
      const code = new URL(result.data.redirect!).searchParams.get("code")!;
      const token = (await tokenFor(code)).data.access_token;
      if (token) expect(await introspect(token)).toEqual({ active: true });
    }
  });

  it("4台目で最も古いブラウザを失効し、その全連携先トークンも無効になる", async () => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const sessionCookie = confirmed.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const firstCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const firstToken = (await tokenFor(firstCode)).data.access_token!;
    const query = new URLSearchParams({ client_id: "atnd", redirect_uri: "https://atnd.tmedit.org/auth/verify/callback", state, code_challenge: await sha256(verifier), code_challenge_method: "S256" });
    const secondFlowResponse = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } });
    const secondFlow = new URL(secondFlowResponse.headers.get("Location")!, base).searchParams.get("flow")!;
    const secondCodeResponse = await post("/auth/continue", { flow: secondFlow }, `${first.cookie}; ${sessionCookie}`);
    const secondCode = new URL((await secondCodeResponse.json() as { redirect: string }).redirect).searchParams.get("code")!;
    const secondToken = (await tokenFor(secondCode, "atnd")).data.access_token!;
    const firstSessionHash = await sha256(sessionCookie.split("=")[1]);
    await env.DB.prepare("UPDATE sessions SET last_seen=last_seen-10 WHERE session_hash=?").bind(firstSessionHash).run();
    for (let index = 0; index < 3; index++) {
      const next = await begin();
      const result = await verify(next.flow, next.cookie, await seedLink(next.flow));
      expect(result.response.status).toBe(200);
    }
    expect(await introspect(firstToken)).toEqual({ active: false });
    expect(await introspect(secondToken, "atnd")).toEqual({ active: false });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(3);
  });

  it("同じ秒に繰り返すトークン照会では D1 を更新しない", async () => {
    const { flow, cookie } = await begin();
    const confirmed = await verify(flow, cookie, await seedLink(flow));
    const code = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const token = (await tokenFor(code)).data.access_token!;
    const queries: string[] = [];
    const database = {
      prepare: (query: string) => {
        queries.push(query);
        return env.DB.prepare(query);
      },
    } as D1Database;
    const check = async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${base}/auth/introspect`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "tmedit", client_secret: testSecrets.CLIENT_SECRET_MAIN, token }),
      }), { ...testEnv, DB: database }, ctx);
      await waitOnExecutionContext(ctx);
      expect(await response.json()).toEqual({ active: true });
    };

    const now = Math.floor(Date.now() / 1000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      await env.DB.prepare("UPDATE sessions SET last_seen=?").bind(now - 1).run();
      await check();
      expect(queries.filter(query => query.startsWith("UPDATE sessions SET last_seen"))).toHaveLength(1);
      expect((await env.DB.prepare("SELECT last_seen FROM sessions").first<{ last_seen: number }>())?.last_seen).toBe(now);

      queries.length = 0;
      await check();
      expect(queries).toHaveLength(1);
      expect(queries[0].startsWith("SELECT s.id,s.last_seen")).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["30日無操作", "90日上限"] as const)("%sで失効したセッションを再確認しても古いトークンは復活しない", async (reason) => {
    const first = await begin();
    const confirmed = await verify(first.flow, first.cookie, await seedLink(first.flow));
    const sessionCookie = confirmed.response.headers.getSetCookie().find(value => value.startsWith("__Host-session="))!.split(";")[0];
    const firstCode = new URL(confirmed.data.redirect!).searchParams.get("code")!;
    const oldToken = (await tokenFor(firstCode)).data.access_token!;
    const oldSession = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    const now = Math.floor(Date.now() / 1000);
    if (reason === "30日無操作") {
      await env.DB.prepare("UPDATE sessions SET last_seen=?").bind(now - 30 * 86400).run();
    } else {
      await env.DB.prepare("UPDATE sessions SET created_at=?").bind(now - 90 * 86400).run();
    }
    expect(await introspect(oldToken)).toEqual({ active: false });

    const query = new URLSearchParams({ client_id: "tmedit", redirect_uri: "https://tmedit.org/auth/verify/callback", state, code_challenge: await sha256(verifier), code_challenge_method: "S256" });
    const started = await call(`/auth/authorize?${query}`, { headers: { Cookie: `${first.cookie}; ${sessionCookie}` } });
    const flow = new URL(started.headers.get("Location")!, base).searchParams.get("flow")!;
    const again = await verify(flow, `${first.cookie}; ${sessionCookie}`, await seedLink(flow));
    expect(again.response.status).toBe(200);
    const newSession = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    expect(newSession?.id).not.toBe(oldSession?.id);
    expect(await introspect(oldToken)).toEqual({ active: false });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM client_tokens WHERE token_hash=?").bind(await sha256(oldToken)).first<{ n: number }>())?.n).toBe(0);
    const newCode = new URL(again.data.redirect!).searchParams.get("code")!;
    const newToken = (await tokenFor(newCode)).data.access_token!;
    expect(await introspect(newToken)).toEqual({ active: true });
  });
});
