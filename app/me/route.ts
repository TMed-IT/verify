import { handleRoute } from "@/src/server/route";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleRoute(request);
}
