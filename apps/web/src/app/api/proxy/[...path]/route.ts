import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl, SESSION_COOKIE } from '@/lib/session';

/**
 * Forwards browser requests to the API, attaching the API token from the httpOnly session cookie.
 * The token never reaches client-side JavaScript.
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token)
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } },
      { status: 401 },
    );

  const target = `${apiBaseUrl()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };
  // The API validates the ID and generates one when it is missing or unsafe.
  const requestId = req.headers.get('x-request-id');
  if (requestId) headers['x-request-id'] = requestId;
  // Only forward a body (and its content type) when there is one: the API rejects
  // an empty body labelled as JSON, which is what bodiless POSTs like "acknowledge" send.
  const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : '';
  if (body) headers['content-type'] = req.headers.get('content-type') ?? 'application/json';

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: body || undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return NextResponse.json(
      { error: { code: 'API_UNREACHABLE', message: 'The monitoring API is unreachable' } },
      { status: 502 },
    );
  }
  const payload = res.status === 204 ? null : await res.arrayBuffer();
  return new NextResponse(payload, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
      ...(res.headers.get('x-request-id')
        ? { 'x-request-id': res.headers.get('x-request-id')! }
        : {}),
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
