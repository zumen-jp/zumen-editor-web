export function GET(): Response {
  return Response.json(
    { ok: true, service: "zumen-editor-web" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
