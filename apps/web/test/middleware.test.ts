// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from '@/middleware';

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

describe('middleware', () => {
  it('blocks the image optimizer endpoint', () => {
    const res = middleware(req('/_next/image?url=%2Fx.svg&w=64&q=75', 'schm_session=t'));
    expect(res.status).toBe(404);
  });

  it('redirects signed-out pages to login and keeps the target', () => {
    const res = middleware(req('/events?topic=mint'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost/login?next=%2Fevents%3Ftopic%3Dmint',
    );
  });

  it('returns 401 JSON for signed-out API calls and lets public paths through', async () => {
    const api = middleware(req('/api/proxy/status'));
    expect(api.status).toBe(401);
    expect(middleware(req('/login')).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(req('/api/health')).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(req('/', 'schm_session=t')).headers.get('x-middleware-next')).toBe('1');
  });
});
