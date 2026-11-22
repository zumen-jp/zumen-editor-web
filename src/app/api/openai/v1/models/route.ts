import { proxyModelsRequest } from "@/server/siwc/proxy";

export async function GET(request: Request): Promise<Response> {
  return proxyModelsRequest(request);
}
