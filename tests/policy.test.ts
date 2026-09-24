import { describe, expect, it } from "vitest";
import { allowedEmail, hmac, normalizeEmail, validChallenge, validState } from "../src/policy";

describe("メールと暗号学的な識別子", () => {
  it("メールを正規化し、形式と許可正規表現を全体一致で判定する", () => {
    expect(normalizeEmail("  Alice@Example.ORG  ")).toBe("alice@example.org");
    expect(normalizeEmail("a..b@example.org")).toBeNull();
    expect(normalizeEmail("a@example.-org")).toBeNull();
    expect(normalizeEmail("a@localhost")).toBeNull();
    expect(normalizeEmail("a@b@example.org\nBcc:bad@example.org")).toBeNull();
    expect(allowedEmail("alice@example.org", "@example\\.org")).toBe(false);
    expect(allowedEmail("alice@example.org", "[a-z]+@example\\.org")).toBe(true);
    expect(allowedEmail("alice@example.org.evil", "[a-z]+@example\\.org")).toBe(false);
  });
  it("正規化済みの同じメールだけが同じHMACになる", async () => {
    const secret = "testing-secret-with-at-least-32-characters";
    const first = await hmac(secret, "email", normalizeEmail(" Alice@Example.org ")!);
    expect(first).toBe(await hmac(secret, "email", normalizeEmail("alice@example.org")!));
    expect(first).not.toBe(await hmac(secret, "email", "bob@example.org"));
    expect(first).not.toBe(await hmac(secret, "ip", "alice@example.org"));
  });
});

describe("OAuth入力", () => {
  it("state と S256 チャレンジの形式を検査する", () => {
    expect(validState("a".repeat(32))).toBe(true);
    expect(validState("short")).toBe(false);
    expect(validChallenge("a".repeat(43))).toBe(true);
    expect(validChallenge("a".repeat(42))).toBe(false);
  });
});
