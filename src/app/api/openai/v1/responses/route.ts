import { proxyResponsesRequest } from "@/server/siwc/proxy";

export async function POST(request: Request): Promise<Response> {
  return proxyResponsesRequest(request);
}
