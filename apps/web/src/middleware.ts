import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session';

const PUBLIC_PATHS = ['/login', '/api/health'];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Image optimization is disabled (next.config.ts); refuse the endpoint outright.
  if (pathname.startsWith('/_next/image')) return new NextResponse(null, { status: 404 });
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname + search)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico|icon.svg).*)'],
};
