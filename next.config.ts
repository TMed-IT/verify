import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { resolve } from "node:path";

const htmlLoader = resolve("scripts/html-loader.cjs");

const development = process.env.NODE_ENV === "development";
const securityHeaders = [
  { key: "Content-Security-Policy", value: [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${development ? " ws: http: https:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ") },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

const config: NextConfig = {
  agentRules: false,
  images: { unoptimized: true },
  turbopack: { rules: { "*.html": { loaders: [htmlLoader], as: "*.js" } } },
  webpack(config) {
    config.module.rules.push({ test: /\.html$/, use: [htmlLoader] });
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;

if (development) {
  initOpenNextCloudflareForDev({
    configPath: resolve(process.cwd(), ".wrangler.local.jsonc"),
    persist: { path: resolve(process.cwd(), ".wrangler/state/v3") },
  });
}
