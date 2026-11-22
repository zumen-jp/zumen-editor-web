import { loadSiwcConfig } from "@/server/siwc/config";
import { verifySameOriginRequest } from "@/server/siwc/csrf";
import { buildClearSessionCookie } from "@/server/siwc/proxy";

export async function POST(request: Request): Promise<Response> {
  const config = loadSiwcConfig(request.url);
  const csrfError = verifySameOriginRequest(request, config);
  if (csrfError) {
    return Response.json({ error: { code: "forbidden", message: csrfError } }, { status: 403 });
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": buildClearSessionCookie(config),
      },
    },
  );
}
