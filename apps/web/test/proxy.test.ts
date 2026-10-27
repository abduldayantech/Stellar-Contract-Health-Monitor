// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

let cookieValue: string | undefined = 'schm_token';
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));

const { POST, GET } = await import('@/app/api/proxy/[...path]/route');
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  cookieValue = 'schm_token';
});

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

describe('API proxy', () => {
  it('forwards bodiless POSTs without a JSON content type', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const req = new NextRequest('http://localhost/api/proxy/alerts/a1/acknowledge', {
      method: 'POST',
    });
    await POST(req, ctx('alerts', 'a1', 'acknowledge'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4000/alerts/a1/acknowledge');
    expect(init.headers.authorization).toBe('Bearer schm_token');
    expect(init.headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('forwards JSON bodies and query strings', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    const req = new NextRequest('http://localhost/api/proxy/contracts?x=1', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req, ctx('contracts'));
    expect(res.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:4000/contracts?x=1');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('streams downloads through with their content disposition', async () => {
    fetchMock.mockResolvedValue(
      new Response('ledger\r\n1\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="events.csv"',
        },
      }),
    );
    const res = await GET(
      new NextRequest('http://localhost/api/proxy/events/export?format=csv'),
      ctx('events', 'export'),
    );
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="events.csv"');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await res.text()).toBe('ledger\r\n1\r\n');
  });

  it('rejects requests without a session and reports an unreachable API', async () => {
    cookieValue = undefined;
    const noSession = await GET(
      new NextRequest('http://localhost/api/proxy/status'),
      ctx('status'),
    );
    expect(noSession.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    cookieValue = 'schm_token';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const down = await GET(new NextRequest('http://localhost/api/proxy/status'), ctx('status'));
    expect(down.status).toBe(502);
    expect((await down.json()).error.code).toBe('API_UNREACHABLE');
  });

  it('encodes path segments so they cannot escape the API base path', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await GET(new NextRequest('http://localhost/api/proxy/x'), ctx('contracts', '../settings'));
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:4000/contracts/..%2Fsettings');
  });
});
