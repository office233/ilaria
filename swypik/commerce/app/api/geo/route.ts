import { withErrorHandling } from "@/lib/api-handler";
export const runtime = "edge";

const EU = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","IS","LI","NO","CH","GB",
]);

async function GET_impl(req: Request) {
  const h = req.headers;
  const country = (
    h.get("cf-ipcountry") ||
    h.get("x-vercel-ip-country") ||
    h.get("x-country") ||
    "RO"
  ).toUpperCase();
  return Response.json({ country, isEU: EU.has(country) });
}

export const GET = withErrorHandling(GET_impl);
