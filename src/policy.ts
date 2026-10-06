import { timingSafeEqual } from "node:crypto";
import siteConfig from "./config.mjs";

export const LINK_SECONDS = 5 * 60;
export const FLOW_SECONDS = 15 * 60;
export const CODE_SECONDS = 5 * 60;
export const IDLE_SECONDS = 30 * 24 * 60 * 60;
export const MAX_SECONDS = 90 * 24 * 60 * 60;

export const CLIENTS = siteConfig.clients;

export type ClientId = keyof typeof CLIENTS;

export function clientFor(id: string) {
  if (!Object.hasOwn(CLIENTS, id)) return null;
  const key = id as ClientId;
  const client = CLIENTS[key];
  return { id: key, origin: client.origin, redirectUri: `${client.origin}${siteConfig.auth.callbackPath}`, secretName: client.secret };
}

export function validRedirect(clientId: string, value: string): boolean {
  const client = clientFor(clientId);
  return client !== null && value === client.redirectUri;
}

export function validState(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

export function validChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value.length > 254 || value.length < 3 || /[\r\n\x00-\x20\x7f]/.test(value)) return null;
  const parts = value.split("@");
  if (parts.length !== 2 || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..")) return null;
  const labels = parts[1].split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return value;
}

export function allowedEmail(email: string, source: string): boolean {
  if (!source || source.length > 512) throw new Error("invalid allow regex configuration");
  const expression = new RegExp(source, "u");
  const match = expression.exec(email);
  return match !== null && match.index === 0 && match[0].length === email.length;
}

export function sessionActive(created: number, seen: number, now: number): boolean {
  return now < created + MAX_SECONDS && now < seen + IDLE_SECONDS;
}

export function encode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export async function hmac(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${purpose}:${value}`))));
}

export async function secureEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)), crypto.subtle.digest("SHA-256", new TextEncoder().encode(b))]);
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
