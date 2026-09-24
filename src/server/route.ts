import { getCloudflareContext } from "@opennextjs/cloudflare";
import auth from "./auth";

export function handleRoute(request: Request): Promise<Response> {
  const { env, ctx } = getCloudflareContext();
  return auth.fetch(request, env as Env, ctx);
}
