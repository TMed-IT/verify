import assert from "node:assert/strict";
import test from "node:test";
import { validateDeploymentEnv } from "../scripts/deploy.mjs";

const env = {
  D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
  HMAC_SECRET: "x".repeat(32),
  AUTH_EMAIL_ALLOW_REGEX: "^[^@]+@example\\.org$",
};

test("配備時のメール許可式は Worker と同じ Unicode モードで検証する", () => {
  assert.doesNotThrow(() => validateDeploymentEnv(env));
  assert.throws(() => validateDeploymentEnv({ ...env, AUTH_EMAIL_ALLOW_REGEX: String.raw`\8` }), /AUTH_EMAIL_ALLOW_REGEX/);
});
