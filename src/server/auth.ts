import {
  allowedEmail, clientFor, CODE_SECONDS, FLOW_SECONDS, hmac, IDLE_SECONDS,
  LINK_SECONDS, MAX_SECONDS, normalizeEmail, randomToken, secureEqual,
  sessionActive, sha256, validChallenge, validRedirect, validState,
} from "../policy";
import { verificationEmail } from "./email";

type Flow = {
  id: string;
  browser_hash: string;
  client_id: string | null;
  state: string | null;
  code_challenge: string | null;
  expires_at: number;
};
type Session = {
  id: string;
  email_key: string;
  browser_hash: string;
  session_hash: string;
  created_at: number;
  last_seen: number;
};
type Link = { email_key: string };
type AuthCode = { code_challenge: string };
type LinkStatus = "ready" | "other_browser" | "invalid";

const COOKIE_BROWSER = "__Host-browser";
const COOKIE_SESSION = "__Host-session";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const BASE_HEADERS = { "Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...JSON_HEADERS, ...headers } });
}
function redirect(to: string, cookie?: string): Response {
  const headers = new Headers(BASE_HEADERS);
  headers.set("Location", to);
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
function cookie(request: Request, name: string): string | null {
  const all = request.headers.get("Cookie") || "";
  for (const pair of all.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}
function setCookie(name: string, value: string, maxAge = MAX_SECONDS): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function expiredCookie(name: string): string { return setCookie(name, "", 0); }
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  if (origin === env.PUBLIC_ORIGIN) return true;
  return Object.values(["tmedit", "atnd", "cs"]).some(id => clientFor(id)?.origin === origin);
}
function cors(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  return origin && ["tmedit", "atnd", "cs"].some(id => clientFor(id)?.origin === origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" }
    : {};
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length") || 0) > 4096) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  const text = chunks.join("") + decoder.decode();
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function string(value: unknown, max = 512): string | null { return typeof value === "string" && value.length <= max ? value : null; }

async function flowFor(request: Request, env: Env, id: string): Promise<Flow | null> {
  const browser = cookie(request, COOKIE_BROWSER);
  if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return null;
  const browserHash = await sha256(browser);
  const flow = await env.DB.prepare("SELECT * FROM flows WHERE id=? AND expires_at>?").bind(id, nowSeconds()).first<Flow>();
  return flow && flow.browser_hash === browserHash ? flow : null;
}

async function activeSession(request: Request, env: Env, touch = true): Promise<Session | null> {
  const token = cookie(request, COOKIE_SESSION);
  const browser = cookie(request, COOKIE_BROWSER);
  if (!token || !browser) return null;
  const [sessionHash, browserHash] = await Promise.all([sha256(token), sha256(browser)]);
  const now = nowSeconds();
  const session = touch
    ? await env.DB.prepare("UPDATE sessions SET last_seen=? WHERE session_hash=? AND browser_hash=? AND created_at>? AND last_seen>? RETURNING *")
      .bind(now, sessionHash, browserHash, now - MAX_SECONDS, now - IDLE_SECONDS).first<Session>()
    : await env.DB.prepare("SELECT * FROM sessions WHERE session_hash=? AND browser_hash=? AND created_at>? AND last_seen>?")
      .bind(sessionHash, browserHash, now - MAX_SECONDS, now - IDLE_SECONDS).first<Session>();
  if (!session || !sessionActive(session.created_at, session.last_seen, now)) return null;
  return session;
}

async function start(request: Request, env: Env, url: URL): Promise<Response> {
  const isClient = url.pathname === "/auth/authorize";
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  const challenge = url.searchParams.get("code_challenge") || "";
  if (isClient && (!validRedirect(clientId, redirectUri) || !validState(state) || !validChallenge(challenge) || url.searchParams.get("code_challenge_method") !== "S256")) {
    return json({ error: "invalid_authorization_request" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = await hmac(env.HMAC_SECRET, "flow-ip", ip);
  if (!(await env.FLOW_START_IP.limit({ key: ipKey })).success) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }

  let browser = cookie(request, COOKIE_BROWSER);
  if (browser && /^[A-Za-z0-9_-]{43}$/.test(browser)) {
    const browserKey = await sha256(browser);
    if (!(await env.FLOW_START_BROWSER.limit({ key: browserKey })).success) {
      return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
    }
  }
  let cookieHeader: string | undefined;
  if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) {
    browser = randomToken();
    cookieHeader = setCookie(COOKIE_BROWSER, browser);
  }
  const flowId = randomToken();
  const browserHash = await sha256(browser);
  const now = nowSeconds();
  await env.DB.prepare("INSERT INTO flows(id,browser_hash,client_id,state,code_challenge,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
    .bind(flowId, browserHash, isClient ? clientId : null, isClient ? state : null, isClient ? challenge : null, now, now + FLOW_SECONDS).run();
  return redirect(`/start?flow=${flowId}`, cookieHeader);
}

export async function rateLimit(env: Env, key: string, windowSeconds: number, maximum: number): Promise<boolean> {
  const windowStart = Math.floor(nowSeconds() / windowSeconds) * windowSeconds;
  const result = await env.DB.prepare("INSERT INTO rate_limits(bucket_key,window_start,count) VALUES(?,?,1) ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=count+1 WHERE count<? RETURNING count")
    .bind(key, windowStart, maximum).first<{ count: number }>();
  return !!result && result.count <= maximum;
}

async function sendLink(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const generic = async (): Promise<Response> => {
    const remaining = 250 - (Date.now() - started);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    return json({ ok: true });
  };
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = await hmac(env.HMAC_SECRET, "ip", ip);
  if (!(await env.REQUEST_LINK_IP.limit({ key: ipKey })).success) return generic();
  const browser = cookie(request, COOKIE_BROWSER);
  if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return generic();
  if (!(await env.REQUEST_LINK_BROWSER.limit({ key: await sha256(browser) })).success) return generic();
  const input = await body(request);
  const flowId = string(input?.flow, 64);
  const email = normalizeEmail(input?.email);
  if (!flowId || !/^[A-Za-z0-9_-]{43}$/.test(flowId)) return generic();
  const flow = await flowFor(request, env, flowId);
  if (!flow) return generic();
  const ipAllowed = await rateLimit(env, `ip:${ipKey}`, 15 * 60, 10);
  if (!ipAllowed || !email || !allowedEmail(email, env.AUTH_EMAIL_ALLOW_REGEX)) return generic();
  const emailKey = await hmac(env.HMAC_SECRET, "email", email);
  const emailAllowed = await rateLimit(env, `email:${emailKey}`, 60 * 60, 3);
  if (!emailAllowed) return generic();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  const extended = await env.DB.prepare("UPDATE flows SET expires_at=MAX(expires_at,?) WHERE id=? AND expires_at>? AND created_at>? RETURNING id")
    .bind(now + LINK_SECONDS, flow.id, now, now - FLOW_SECONDS).first<{ id: string }>();
  if (!extended) return generic();
  await env.DB.prepare("INSERT INTO magic_links(token_hash,flow_id,email_key,expires_at) VALUES(?,?,?,?)")
    .bind(tokenHash, flow.id, emailKey, now + LINK_SECONDS).run();
  const link = `${env.PUBLIC_ORIGIN}/link?flow=${flow.id}#token=${token}`;
  ctx.waitUntil((async () => {
    try {
      await env.EMAIL.send({
        from: "noreply@verify.tmedit.org",
        to: email,
        ...verificationEmail(link, LINK_SECONDS),
      });
    } catch {
      await env.DB.prepare("DELETE FROM magic_links WHERE token_hash=?").bind(tokenHash).run();
    }
  })());
  return generic();
}

function codeDestination(flow: Flow, code: string): string | null {
  if (!flow.client_id || !flow.state || !flow.code_challenge) return "/verified";
  const client = clientFor(flow.client_id);
  if (!client) return null;
  const target = new URL(client.redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", flow.state);
  return target.toString();
}

async function issueCode(env: Env, flow: Flow, session: Session): Promise<string | null> {
  const now = nowSeconds();
  if (!flow.client_id || !flow.state || !flow.code_challenge) {
    const claimed = await env.DB.prepare("DELETE FROM flows WHERE id=? AND expires_at>? RETURNING id")
      .bind(flow.id, now).first<{ id: string }>();
    return claimed ? "/verified" : null;
  }
  const code = randomToken();
  const destination = codeDestination(flow, code);
  if (!destination) return null;
  const codeHash = await sha256(code);
  const results = await env.DB.batch<{ code_hash?: string; id?: string }>([
    env.DB.prepare("INSERT INTO auth_codes(code_hash,session_id,client_id,code_challenge,expires_at) SELECT ?,s.id,f.client_id,f.code_challenge,? FROM flows f JOIN sessions s ON s.id=? WHERE f.id=? AND f.expires_at>? AND s.browser_hash=f.browser_hash AND s.created_at>? AND s.last_seen>? RETURNING code_hash")
      .bind(codeHash, now + CODE_SECONDS, session.id, flow.id, now, now - MAX_SECONDS, now - IDLE_SECONDS),
    env.DB.prepare("DELETE FROM flows WHERE id=? AND EXISTS(SELECT 1 FROM auth_codes WHERE code_hash=?) RETURNING id")
      .bind(flow.id, codeHash),
  ]);
  return results[0].results.length === 1 && results[1].results.length === 1 ? destination : null;
}

async function confirm(request: Request, env: Env): Promise<Response> {
  const input = await body(request);
  const flowId = string(input?.flow, 64);
  const token = string(input?.token, 64);
  if (!flowId || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: "invalid_link" }, 400);
  const flow = await flowFor(request, env, flowId);
  if (!flow) return json({ error: "different_browser_or_expired" }, 409);
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  const link = await env.DB.prepare("SELECT email_key FROM magic_links WHERE token_hash=? AND flow_id=? AND expires_at>?")
    .bind(tokenHash, flow.id, now).first<Link>();
  if (!link) return json({ error: "invalid_link" }, 400);
  const newSessionToken = randomToken();
  const sessionHash = await sha256(newSessionToken);
  const sessionId = crypto.randomUUID();
  const hasClient = !!(flow.client_id && flow.state && flow.code_challenge);
  const code = hasClient ? randomToken() : "";
  const destination = codeDestination(flow, code);
  if (!destination) return json({ error: "session_superseded" }, 409);
  const codeHash = hasClient ? await sha256(code) : null;
  const statements = [
    // The temporary expiry marks this flow as claimed inside the D1 transaction.
    env.DB.prepare("UPDATE flows SET expires_at=-1 WHERE id=? AND browser_hash=? AND expires_at>? AND EXISTS(SELECT 1 FROM magic_links WHERE token_hash=? AND flow_id=? AND expires_at>?) RETURNING id")
      .bind(flow.id, flow.browser_hash, now, tokenHash, flow.id, now),
    env.DB.prepare("DELETE FROM sessions WHERE email_key=? AND (created_at<=? OR last_seen<=?) AND EXISTS(SELECT 1 FROM flows WHERE id=? AND expires_at=-1)")
      .bind(link.email_key, now - MAX_SECONDS, now - IDLE_SECONDS, flow.id),
    env.DB.prepare("DELETE FROM sessions WHERE browser_hash=? AND EXISTS(SELECT 1 FROM flows WHERE id=? AND expires_at=-1)")
      .bind(flow.browser_hash, flow.id),
    env.DB.prepare("INSERT INTO sessions(id,email_key,browser_hash,session_hash,created_at,last_seen) SELECT ?,m.email_key,f.browser_hash,?,?,? FROM flows f JOIN magic_links m ON m.flow_id=f.id WHERE f.id=? AND f.expires_at=-1 AND m.token_hash=? AND m.expires_at>? RETURNING id")
      .bind(sessionId, sessionHash, now, now, flow.id, tokenHash, now),
    env.DB.prepare("DELETE FROM sessions WHERE email_key=? AND id NOT IN (SELECT id FROM sessions WHERE email_key=? ORDER BY CASE WHEN id=? THEN 1 ELSE 0 END DESC,last_seen DESC,rowid DESC LIMIT 3) AND EXISTS(SELECT 1 FROM flows WHERE id=? AND expires_at=-1)")
      .bind(link.email_key, link.email_key, sessionId, flow.id),
  ];
  if (codeHash) {
    statements.push(env.DB.prepare("INSERT INTO auth_codes(code_hash,session_id,client_id,code_challenge,expires_at) SELECT ?,s.id,f.client_id,f.code_challenge,? FROM flows f JOIN sessions s ON s.id=? WHERE f.id=? AND f.expires_at=-1 RETURNING code_hash")
      .bind(codeHash, now + CODE_SECONDS, sessionId, flow.id));
  }
  // Completing a confirmation supersedes other pending confirmations in this browser.
  // Their claim then fails before they can replace this session or set another cookie.
  statements.push(env.DB.prepare("DELETE FROM flows WHERE browser_hash=? AND id<>? AND EXISTS(SELECT 1 FROM flows WHERE id=? AND expires_at=-1)")
    .bind(flow.browser_hash, flow.id, flow.id));
  statements.push(env.DB.prepare(`DELETE FROM flows WHERE id=? AND expires_at=-1 AND EXISTS(SELECT 1 FROM sessions WHERE id=?)${codeHash ? " AND EXISTS(SELECT 1 FROM auth_codes WHERE code_hash=?)" : ""} RETURNING id`)
    .bind(...(codeHash ? [flow.id, sessionId, codeHash] : [flow.id, sessionId])));
  const results = await env.DB.batch<{ id?: string; code_hash?: string }>(statements);
  if (results[0].results.length === 0) return json({ error: "session_superseded" }, 409);
  if (results[3].results.length !== 1 || results.at(-1)?.results.length !== 1 || (codeHash && results[5].results.length !== 1)) {
    throw new Error("confirmation transaction did not complete");
  }
  const response = json({ ok: true, redirect: destination });
  response.headers.append("Set-Cookie", setCookie(COOKIE_BROWSER, cookie(request, COOKIE_BROWSER)!));
  response.headers.append("Set-Cookie", setCookie(COOKIE_SESSION, newSessionToken));
  return response;
}

async function linkStatus(request: Request, env: Env): Promise<Response> {
  const input = await body(request);
  const flowId = string(input?.flow, 64);
  const token = string(input?.token, 64);
  if (!flowId || !token || !/^[A-Za-z0-9_-]{43}$/.test(flowId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return json({ status: "invalid" satisfies LinkStatus });
  }

  const tokenHash = await sha256(token);
  const now = nowSeconds();
  const link = await env.DB.prepare(
    "SELECT f.browser_hash FROM magic_links m JOIN flows f ON f.id=m.flow_id WHERE m.token_hash=? AND m.flow_id=? AND m.expires_at>? AND f.expires_at>?",
  ).bind(tokenHash, flowId, now, now).first<{ browser_hash: string }>();
  if (!link) return json({ status: "invalid" satisfies LinkStatus });

  const browser = cookie(request, COOKIE_BROWSER);
  const sameBrowser = !!browser && /^[A-Za-z0-9_-]{43}$/.test(browser) &&
    await sha256(browser) === link.browser_hash;
  return json({ status: (sameBrowser ? "ready" : "other_browser") satisfies LinkStatus });
}

async function continueFlow(request: Request, env: Env): Promise<Response> {
  const input = await body(request);
  const flowId = string(input?.flow, 64);
  if (!flowId) return json({ error: "invalid_flow" }, 400);
  const flow = await flowFor(request, env, flowId);
  const session = await activeSession(request, env);
  if (!flow || !session || flow.browser_hash !== session.browser_hash) return json({ error: "authentication_required" }, 401);
  const destination = await issueCode(env, flow, session);
  return destination ? json({ ok: true, redirect: destination }) : json({ error: "session_superseded" }, 409);
}

async function authenticateClient(input: Record<string, unknown> | null, env: Env): Promise<ReturnType<typeof clientFor>> {
  const clientId = string(input?.client_id, 20);
  const givenSecret = string(input?.client_secret, 512);
  if (!clientId || !givenSecret) return null;
  const client = clientFor(clientId);
  if (!client) return null;
  const binding = env[client.secretName as "CLIENT_SECRET_MAIN" | "CLIENT_SECRET_ATND" | "CLIENT_SECRET_CS"];
  const expected = await binding.get();
  if (typeof expected !== "string" || expected.length < 32 || !(await secureEqual(givenSecret, expected))) return null;
  return client;
}

async function exchange(request: Request, env: Env): Promise<Response> {
  const input = await body(request);
  const client = await authenticateClient(input, env);
  if (!client) return json({ error: "unauthorized_client" }, 401);
  const code = string(input?.code, 64);
  const verifier = string(input?.code_verifier, 128);
  if (!code || !verifier || !/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || input?.redirect_uri !== client.redirectUri) return json({ error: "invalid_grant" }, 400);
  const codeHash = await sha256(code);
  const record = await env.DB.prepare("SELECT code_challenge FROM auth_codes WHERE code_hash=? AND client_id=? AND expires_at>?")
    .bind(codeHash, client.id, nowSeconds()).first<AuthCode>();
  if (!record || !(await secureEqual(await sha256(verifier), record.code_challenge))) return json({ error: "invalid_grant" }, 400);
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  const results = await env.DB.batch<{ token_hash?: string; code_hash?: string; created_at?: number }>([
    env.DB.prepare("INSERT INTO client_tokens(token_hash,session_id,client_id) SELECT ?,s.id,c.client_id FROM auth_codes c JOIN sessions s ON s.id=c.session_id WHERE c.code_hash=? AND c.client_id=? AND c.code_challenge=? AND c.expires_at>? AND s.created_at>? AND s.last_seen>? RETURNING token_hash")
      .bind(tokenHash, codeHash, client.id, record.code_challenge, now, now - MAX_SECONDS, now - IDLE_SECONDS),
    env.DB.prepare("DELETE FROM auth_codes WHERE code_hash=? AND EXISTS(SELECT 1 FROM client_tokens WHERE token_hash=?) RETURNING code_hash")
      .bind(codeHash, tokenHash),
    env.DB.prepare("SELECT s.created_at FROM sessions s JOIN client_tokens t ON t.session_id=s.id WHERE t.token_hash=?")
      .bind(tokenHash),
  ]);
  if (results[0].results.length === 0) return json({ error: "invalid_grant" }, 400);
  const session = results[2].results[0];
  if (results[1].results.length !== 1 || session?.created_at === undefined) throw new Error("token exchange transaction did not complete");
  const expiresIn = Math.max(0, session.created_at + MAX_SECONDS - nowSeconds());
  return json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

async function introspect(request: Request, env: Env): Promise<Response> {
  const input = await body(request);
  const client = await authenticateClient(input, env);
  if (!client) return json({ error: "unauthorized_client" }, 401);
  const token = string(input?.token, 64);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ active: false });
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  const session = await env.DB.prepare("SELECT s.id,s.last_seen FROM sessions s JOIN client_tokens t ON t.session_id=s.id WHERE t.token_hash=? AND t.client_id=? AND s.created_at>? AND s.last_seen>?")
    .bind(tokenHash, client.id, now - MAX_SECONDS, now - IDLE_SECONDS).first<Pick<Session, "id" | "last_seen">>();
  if (!session) return json({ active: false });
  // Timestamps have one-second precision; repeated requests in that second need no write.
  if (session.last_seen >= now) return json({ active: true });
  const touched = await env.DB.prepare("UPDATE sessions SET last_seen=? WHERE id=? AND last_seen<? AND created_at>? AND last_seen>? AND EXISTS(SELECT 1 FROM client_tokens WHERE token_hash=? AND client_id=? AND session_id=?) RETURNING id")
    .bind(now, session.id, now, now - MAX_SECONDS, now - IDLE_SECONDS, tokenHash, client.id, session.id).first<{ id: string }>();
  if (touched) return json({ active: true });
  // Another request may have touched this session after the first read.
  const current = await env.DB.prepare("SELECT 1 FROM sessions s JOIN client_tokens t ON t.session_id=s.id WHERE s.id=? AND t.token_hash=? AND t.client_id=? AND s.created_at>? AND s.last_seen>?")
    .bind(session.id, tokenHash, client.id, now - MAX_SECONDS, now - IDLE_SECONDS).first();
  return json({ active: !!current });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const browser = cookie(request, COOKIE_BROWSER);
  if (browser && /^[A-Za-z0-9_-]{43}$/.test(browser)) {
    await env.DB.prepare("DELETE FROM sessions WHERE browser_hash=?").bind(await sha256(browser)).run();
  }
  const response = json({ ok: true }, 200, cors(request));
  response.headers.append("Set-Cookie", expiredCookie(COOKIE_SESSION));
  response.headers.append("Set-Cookie", expiredCookie(COOKIE_BROWSER));
  return response;
}

function validateConfig(env: Env): void {
  if (!env.AUTH_EMAIL_ALLOW_REGEX || !env.HMAC_SECRET || env.HMAC_SECRET.length < 32 || !env.PUBLIC_ORIGIN) throw new Error("missing auth configuration");
  if (env.PUBLIC_ORIGIN !== "https://verify.tmedit.org" && !/^http:\/\/localhost:\d{2,5}$/.test(env.PUBLIC_ORIGIN)) throw new Error("invalid public origin");
  // Fail closed on a malformed pattern before accepting a send request.
  allowedEmail("probe@example.org", env.AUTH_EMAIL_ALLOW_REGEX);
}

export async function cleanup(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM flows WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM auth_codes WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE created_at<=? OR last_seen<=?").bind(now - MAX_SECONDS, now - IDLE_SECONDS),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(now - 2 * 60 * 60),
  ]);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      validateConfig(env);
      const url = new URL(request.url);
      if (request.method === "OPTIONS" && ["/auth/logout"].includes(url.pathname)) {
        return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...cors(request), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
      }
      if (request.method === "GET" && ["/", "/auth/authorize"].includes(url.pathname)) return await start(request, env, url);
      if (request.method === "GET" && url.pathname === "/auth/flow") {
        const id = url.searchParams.get("flow") || "";
        const flow = await flowFor(request, env, id);
        if (!flow) return json({ valid: false });
        return json({ valid: true, client: flow.client_id, authenticated: !!(await activeSession(request, env)) });
      }
      if (request.method === "GET" && url.pathname === "/me") return json({ authenticated: !!(await activeSession(request, env)) });
      if (request.method === "POST" && ["/auth/request-link", "/auth/link/status", "/auth/confirm", "/auth/continue", "/auth/logout"].includes(url.pathname)) {
        if (!originAllowed(request, env)) return json({ error: "forbidden" }, 403);
        if (url.pathname === "/auth/request-link") return await sendLink(request, env, ctx);
        if (url.pathname === "/auth/link/status") return await linkStatus(request, env);
        if (url.pathname === "/auth/confirm") return await confirm(request, env);
        if (url.pathname === "/auth/continue") return await continueFlow(request, env);
        return await logout(request, env);
      }
      if (request.method === "POST" && url.pathname === "/auth/token") return await exchange(request, env);
      if (request.method === "POST" && url.pathname === "/auth/introspect") return await introspect(request, env);
      return json({ error: "not_found" }, 404);
    } catch {
      // Never log the request URL, address, token, or email service exception.
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
