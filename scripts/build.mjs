import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(".env");
const backupPath = resolve(`.env.build.${randomUUID()}`);
const binary = resolve("node_modules", ".bin", process.platform === "win32" ? "opennextjs-cloudflare.cmd" : "opennextjs-cloudflare");

// 配備用の暗号化 .env を Next.js / OpenNext のビルドに含めない。
await rename(envPath, backupPath);
try {
  const child = spawn(binary, ["build", ...process.argv.slice(2)], { stdio: "inherit" });
  const forwardSignal = () => child.kill("SIGTERM");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forwardSignal);
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveExit(code ?? 1));
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, forwardSignal);
  }
} finally {
  await rename(backupPath, envPath);
}
