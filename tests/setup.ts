import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";

beforeAll(async () => {
  const schema = (env as Env & { TEST_SCHEMA: string }).TEST_SCHEMA;
  for (const statement of schema.split(";").map(value => value.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});
beforeEach(async () => {
  for (const table of ["client_tokens", "auth_codes", "sessions", "magic_links", "flows", "rate_limits"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});
