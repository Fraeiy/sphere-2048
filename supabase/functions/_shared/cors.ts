/**
 * CORS for Sphere 2048 Edge Functions.
 * Reflects a trusted request Origin when present; falls back to FRONTEND_URL.
 */

const DEFAULT_FRONTEND = 'https://sphere-2048.vercel.app';

const ALLOWED_ORIGINS = new Set(
  [
    Deno.env.get('FRONTEND_URL'),
    DEFAULT_FRONTEND,
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
  ].filter((o): o is string => Boolean(o && o.trim())),
);

function resolveAllowOrigin(req?: Request): string {
  const requestOrigin = req?.headers.get('Origin')?.trim();
  if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
    return requestOrigin;
  }
  // Prefer explicit FRONTEND_URL only if it is our app (avoid stale wrong projects).
  const envUrl = Deno.env.get('FRONTEND_URL')?.trim();
  if (envUrl && envUrl.includes('sphere-2048')) {
    return envUrl;
  }
  return DEFAULT_FRONTEND;
}

export function corsHeadersFor(req?: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveAllowOrigin(req),
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-idempotency-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

/** @deprecated Prefer corsHeadersFor(req) so Origin is reflected correctly. */
export const corsHeaders = corsHeadersFor();

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeadersFor(req) });
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status = 400,
  req?: Request,
): Response {
  return jsonResponse({ error: message, code }, status, req);
}
