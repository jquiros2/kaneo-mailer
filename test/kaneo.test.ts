import { describe, expect, it, vi } from 'vitest';
import { KaneoClient, KaneoError } from '../src/kaneo';

function client(response: Response | Error) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return { fetchMock, kaneo: new KaneoClient('https://kaneo.example.com/api', 'key', fetchMock) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('KaneoClient', () => {
  it('fetches columns with a bearer token', async () => {
    const { fetchMock, kaneo } = client(json([{ id: 'c1', slug: 'to-do' }]));
    await expect(kaneo.getColumns('p/1')).resolves.toEqual([{ id: 'c1', slug: 'to-do' }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kaneo.example.com/api/column/p%2F1');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer key' });
  });

  it('creates a task with the expected body', async () => {
    const { fetchMock, kaneo } = client(json({ id: 't1' }));
    await kaneo.createTask('p1', { title: 'T', description: 'D', status: 'mail', dueDate: '2026-12-24T17:30:00.000Z' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kaneo.example.com/api/task/p1');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      title: 'T',
      description: 'D',
      status: 'mail',
      priority: 'no-priority',
      dueDate: '2026-12-24T17:30:00.000Z',
    });
  });

  it('omits an absent due date', async () => {
    const { fetchMock, kaneo } = client(json({ id: 't1' }));
    await kaneo.createTask('p1', { title: 'T', description: '', status: 'mail' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).not.toHaveProperty('dueDate');
  });

  it('turns error responses into KaneoError with the server message', async () => {
    const { kaneo } = client(json({ message: 'Invalid status "x"' }, 400));
    const error = await kaneo.getColumns('p1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaneoError);
    expect((error as KaneoError).status).toBe(400);
    expect((error as KaneoError).message).toContain('Invalid status "x"');
  });

  it('falls back to raw text for non-JSON errors', async () => {
    const { kaneo } = client(new Response('Bad Gateway', { status: 502 }));
    await expect(kaneo.getColumns('p1')).rejects.toThrow('returned 502: Bad Gateway');
  });

  it('reports network failures with status 0', async () => {
    const { kaneo } = client(new Error('ECONNREFUSED'));
    await expect(kaneo.getColumns('p1')).rejects.toMatchObject({ status: 0, permanent: false });
  });

  it.each([
    [400, true],
    [403, true],
    [404, true],
    [401, false],
    [402, false],
    [429, false],
    [500, false],
  ])('status %i permanent=%s', (status, permanent) => {
    expect(new KaneoError('x', status).permanent).toBe(permanent);
  });

  it('stages a draft attachment with the expected body', async () => {
    const { fetchMock, kaneo } = client(
      json({ key: 'k1', uploadUrl: 'https://upload.example/put', headers: { 'Content-Type': 'image/png' } }),
    );
    const file = { filename: 'logo.png', contentType: 'image/png', size: 4, content: Buffer.from('DATA') };
    const staged = await kaneo.stageDraftAsset('p1', file);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kaneo.example.com/api/task/draft-upload/p1');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer key' });
    expect(JSON.parse(init?.body as string)).toEqual({
      filename: 'logo.png',
      contentType: 'image/png',
      size: 4,
      surface: 'description',
    });
    expect(staged).toEqual({
      key: 'k1',
      uploadUrl: 'https://upload.example/put',
      headers: { 'Content-Type': 'image/png' },
    });
  });

  it('uploads bytes to the presigned URL without credentials', async () => {
    const { fetchMock, kaneo } = client(new Response(null, { status: 200 }));
    await kaneo.putUploadBytes('https://upload.example/put', Buffer.from('DATA'), { 'Content-Type': 'image/png' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://upload.example/put');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('DATA');
  });

  it('maps a failed upload to a permanent KaneoError', async () => {
    const { kaneo } = client(new Response('denied', { status: 403 }));
    const error = await kaneo
      .putUploadBytes('https://upload.example/put', Buffer.from('D'), { 'Content-Type': 'text/plain' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KaneoError);
    expect((error as KaneoError).status).toBe(403);
    expect((error as KaneoError).permanent).toBe(true);
  });

  it('finalizes a staged asset and returns the stable asset url', async () => {
    const { fetchMock, kaneo } = client(json({ id: 'a1', url: 'https://kaneo.example.com/api/asset/a1' }));
    const file = { filename: 'logo.png', contentType: 'image/png', size: 4, content: Buffer.from('DATA') };
    const finalized = await kaneo.finalizeDraftAsset('p1', file, 'k1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kaneo.example.com/api/task/draft-upload/p1/finalize');
    expect(JSON.parse(init?.body as string)).toEqual({
      key: 'k1',
      filename: 'logo.png',
      contentType: 'image/png',
      size: 4,
      surface: 'description',
    });
    expect(finalized).toEqual({ id: 'a1', url: 'https://kaneo.example.com/api/asset/a1' });
  });

  it('includes draft asset ids when creating a task', async () => {
    const { fetchMock, kaneo } = client(json({ id: 't1' }));
    await kaneo.createTask('p1', { title: 'T', description: 'D', status: 'mail', draftAssetIds: ['a1'] });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toMatchObject({ draftAssetIds: ['a1'] });
  });

  it('omits draft asset ids when there are none', async () => {
    const { fetchMock, kaneo } = client(json({ id: 't1' }));
    await kaneo.createTask('p1', { title: 'T', description: 'D', status: 'mail' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).not.toHaveProperty('draftAssetIds');
  });
});
