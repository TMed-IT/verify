import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const configPath = ".wrangler.local.jsonc";
const port = process.env.PORT || "3000";
if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) throw new Error("PORT が不正です");
const devVars = await readFile(".dev.vars", "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
if (/^\s*PUBLIC_ORIGIN\s*=/m.test(devVars)) {
  throw new Error("PUBLIC_ORIGIN は .dev.vars に設定せず、PORT でローカルのポートを指定してください");
}
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
config.workers_dev = true;
delete config.routes;
config.vars.PUBLIC_ORIGIN = `http://localhost:${port}`;
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

const binary = resolve("node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
const child = spawn(binary, ["dev", "--hostname", "localhost", "--port", port], { stdio: "inherit" });
const forwardSignal = () => child.kill("SIGTERM");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forwardSignal);
try {
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, forwardSignal);
  await rm(configPath, { force: true });
}
