import { handleRoute } from "@/src/server/route";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRoute(request);
}
