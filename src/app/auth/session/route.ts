import { loadSiwcConfig } from "@/server/siwc/config";
import { toPublicAuthSession } from "@/server/siwc/oauth";
import { readSessionFromRequest } from "@/server/siwc/proxy";

export async function GET(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const session = await readSessionFromRequest(request, config);
  return Response.json(toPublicAuthSession(session, config.isConfigured), {
    headers: { "Cache-Control": "no-store" },
  });
}
