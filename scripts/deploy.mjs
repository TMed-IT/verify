import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientSecretNames, ensureClientSecrets } from "./secrets-store.mjs";

const secretNames = [
  "AUTH_EMAIL_ALLOW_REGEX",
  "HMAC_SECRET",
];
const localStoreId = "00000000000000000000000000000000";

const isMissing = (value) =>
  typeof value !== "string" || !value.trim() || value.startsWith("REPLACE_WITH_");

export function validateDeploymentEnv(env) {
  const required = ["D1_DATABASE_ID", ...secretNames];
  const missing = required.filter((name) => isMissing(env[name]));
  if (missing.length) throw new Error(`未設定の配備変数: ${missing.join(", ")}`);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.D1_DATABASE_ID)) {
    throw new Error("D1_DATABASE_ID は D1 の UUID を指定してください");
  }
  try {
    if (env.AUTH_EMAIL_ALLOW_REGEX.length > 512) throw new Error("too long");
    new RegExp(env.AUTH_EMAIL_ALLOW_REGEX, "u");
  } catch {
    throw new Error("AUTH_EMAIL_ALLOW_REGEX は有効な正規表現にしてください");
  }
  if (env.HMAC_SECRET.length < 32) throw new Error("HMAC_SECRET は32文字以上にしてください");
  return Object.fromEntries(secretNames.map((name) => [name, env[name]]));
}

function run(binaryName, args) {
  const binary = resolve("node_modules", ".bin", process.platform === "win32" ? `${binaryName}.cmd` : binaryName);
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { stdio: "inherit", env: process.env });
    const stop = (signal) => child.kill(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const cleanup = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolveRun();
      else reject(new Error(`${binaryName} が失敗しました (${signal ?? code})`));
    });
  });
}

async function deploy({ checkOnly = false, env = process.env } = {}) {
  const secrets = validateDeploymentEnv(env);
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  if (config.name !== "verify" || config.main !== "custom-worker.ts" ||
      config.assets?.directory !== ".open-next/assets" ||
      config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== "DB") {
    throw new Error("wrangler.jsonc の Worker または D1 設定が想定と異なります");
  }
  if (new Set(config.secrets?.required).size !== secretNames.length ||
      !secretNames.every((name) => config.secrets.required.includes(name))) {
    throw new Error("wrangler.jsonc の secrets.required が配備用 secret と一致しません");
  }
  const rateLimitBindings = ["FLOW_START_IP", "FLOW_START_BROWSER", "REQUEST_LINK_IP", "REQUEST_LINK_BROWSER"];
  if (config.ratelimits?.length !== rateLimitBindings.length ||
      !rateLimitBindings.every((name) => config.ratelimits.some((item) => item.name === name))) {
    throw new Error("wrangler.jsonc のレート制限 binding が不足しています");
  }
  const bindings = config.secrets_store_secrets;
  if (!Array.isArray(bindings) || bindings.length !== clientSecretNames.length ||
      !clientSecretNames.every((name) => bindings.some((item) => item.binding === name && item.secret_name === name)) ||
      !bindings.every((item) => item.store_id === localStoreId)) {
    throw new Error("wrangler.jsonc の Secrets Store binding 設定が想定と異なります");
  }
  if (checkOnly) return;

  const storeId = await ensureClientSecrets({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN });
  console.log(`Secrets Store ID: ${storeId}`);
  for (const binding of bindings) binding.store_id = storeId;
  config.d1_databases[0].database_id = env.D1_DATABASE_ID;
  const suffix = randomUUID();
  const configPath = `.wrangler.deploy.${suffix}.jsonc`;
  const secretsPath = `.wrangler.deploy.${suffix}.secrets.json`;
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await writeFile(secretsPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
    await run("wrangler", ["d1", "execute", "DB", "--remote", "--config", configPath, "--file", "schema.sql", "--yes"]);
    await run("opennextjs-cloudflare", ["deploy", "--config", configPath, "--secrets-file", secretsPath]);
  } finally {
    await Promise.all([
      rm(configPath, { force: true }),
      rm(secretsPath, { force: true }),
    ]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deploy({ checkOnly: process.argv.includes("--check") });
  if (process.argv.includes("--check")) console.log("配備設定を確認しました");
}
