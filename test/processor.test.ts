import { describe, expect, it, vi } from 'vitest';
import { KaneoError, type Column, type KaneoClient } from '../src/kaneo';
import type { MailAttachment, TaskMail } from '../src/message';
import { Processor, resolveColumn } from '../src/processor';

const column = (slug: string, position: number, name = slug): Column => ({
  id: `id-${slug}`,
  projectId: 'p1',
  name,
  slug,
  position,
});

const columns = [column('done', 2, 'Done'), column('to-do', 0, 'To Do'), column('mail', 1, 'Mail')];

const attachment = (overrides: Partial<MailAttachment> = {}): MailAttachment => ({
  filename: 'logo.png',
  contentType: 'image/png',
  size: 4,
  content: Buffer.from('DATA'),
  ...overrides,
});

const mail = (overrides: Partial<TaskMail> = {}): TaskMail => ({
  projectId: 'p1',
  column: null,
  title: 'Title',
  description: 'Body',
  dueDate: null,
  attachments: [],
  ...overrides,
});

function fakeKaneo(
  cols: Column[] | KaneoError = columns,
  create: KaneoError | null = null,
  uploadError: KaneoError | null = null,
) {
  const getColumns = vi.fn(() => (cols instanceof KaneoError ? Promise.reject(cols) : Promise.resolve(cols)));
  const createTask = vi.fn(() => (create ? Promise.reject(create) : Promise.resolve({ id: 't1' })));
  const stageDraftAsset = vi.fn(() =>
    uploadError
      ? Promise.reject(uploadError)
      : Promise.resolve({
          key: 'k1',
          uploadUrl: 'https://upload.example/put',
          headers: { 'Content-Type': 'image/png' },
        }),
  );
  const putUploadBytes = vi.fn(() => Promise.resolve());
  const finalizeDraftAsset = vi.fn(() => Promise.resolve({ id: 'a1', url: 'https://kaneo.example.com/api/asset/a1' }));
  const kaneo = {
    getColumns,
    createTask,
    stageDraftAsset,
    putUploadBytes,
    finalizeDraftAsset,
  } as unknown as KaneoClient;
  return { getColumns, createTask, stageDraftAsset, putUploadBytes, finalizeDraftAsset, kaneo };
}

describe('resolveColumn', () => {
  it('prefers the mail column by default', () => {
    expect(resolveColumn(columns, null)?.slug).toBe('mail');
  });

  it('falls back to the first column by position', () => {
    expect(resolveColumn([column('done', 2), column('backlog', 0)], null)?.slug).toBe('backlog');
  });

  it('matches a column named Mail with another slug', () => {
    expect(resolveColumn([column('to-do', 0), column('inbox', 1, 'Mail')], null)?.slug).toBe('inbox');
  });

  it('matches an explicit id, slug or name', () => {
    expect(resolveColumn(columns, 'id-done')?.slug).toBe('done');
    expect(resolveColumn(columns, 'To-Do')?.slug).toBe('to-do');
    expect(resolveColumn(columns, 'to do')?.slug).toBe('to-do');
  });

  it('returns undefined for an unknown explicit column', () => {
    expect(resolveColumn(columns, 'nope')).toBeUndefined();
  });

  it('returns undefined for a project without columns', () => {
    expect(resolveColumn([], null)).toBeUndefined();
  });
});

describe('Processor', () => {
  it('creates a task in the resolved column', async () => {
    const { kaneo, createTask } = fakeKaneo();
    const outcome = await new Processor(kaneo).process(mail({ dueDate: '2026-12-24T17:30:00.000Z' }));

    expect(outcome).toEqual({ state: 'accepted', taskId: 't1' });
    expect(createTask).toHaveBeenCalledWith('p1', {
      title: 'Title',
      description: 'Body',
      status: 'mail',
      dueDate: '2026-12-24T17:30:00.000Z',
    });
  });

  it('rejects mail without a project header', async () => {
    const { kaneo, getColumns } = fakeKaneo();
    const outcome = await new Processor(kaneo).process(mail({ projectId: null }));
    expect(outcome.state).toBe('rejected');
    expect(outcome).toHaveProperty('reason', 'missing x-kaneo-project-id header');
    expect(getColumns).not.toHaveBeenCalled();
  });

  it('creates a task in the default project when the header is missing', async () => {
    const { kaneo, createTask } = fakeKaneo();
    const processor = new Processor(kaneo, { projectId: 'p1', column: 'to-do' });
    const outcome = await processor.process(mail({ projectId: null, column: null }));

    expect(outcome).toEqual({ state: 'accepted', taskId: 't1' });
    expect(createTask).toHaveBeenCalledWith('p1', expect.objectContaining({ status: 'to-do' }));
  });

  it('prefers the message headers over the defaults', async () => {
    const { kaneo, createTask } = fakeKaneo();
    const processor = new Processor(kaneo, { projectId: 'p1', column: 'mail' });
    await processor.process(mail({ projectId: 'p2', column: 'done' }));

    expect(createTask).toHaveBeenCalledWith('p2', expect.objectContaining({ status: 'done' }));
  });

  it('rejects an unknown column', async () => {
    const { kaneo } = fakeKaneo();
    const outcome = await new Processor(kaneo).process(mail({ column: 'nope' }));
    expect(outcome).toEqual({
      state: 'rejected',
      reason: 'no column matching x-kaneo-column "nope" in project p1',
    });
  });

  it('rejects a project without columns', async () => {
    const { kaneo } = fakeKaneo([]);
    expect(await new Processor(kaneo).process(mail())).toMatchObject({ state: 'rejected' });
  });

  it('rejects when Kaneo refuses the project', async () => {
    const { kaneo } = fakeKaneo(new KaneoError('forbidden', 403));
    expect(await new Processor(kaneo).process(mail())).toEqual({ state: 'rejected', reason: 'forbidden' });
  });

  it('retries on temporary errors', async () => {
    const { kaneo } = fakeKaneo(columns, new KaneoError('server down', 503));
    expect(await new Processor(kaneo).process(mail())).toEqual({ state: 'retry', reason: 'server down' });
  });

  it('rethrows unexpected errors', async () => {
    const { kaneo, getColumns } = fakeKaneo();
    getColumns.mockRejectedValueOnce(new TypeError('boom'));
    await expect(new Processor(kaneo).process(mail())).rejects.toThrow('boom');
  });

  it('fetches columns once per project', async () => {
    const { kaneo, getColumns } = fakeKaneo();
    const processor = new Processor(kaneo);
    await processor.process(mail());
    await processor.process(mail());
    await processor.process(mail({ projectId: 'p2' }));
    expect(getColumns).toHaveBeenCalledTimes(2);
  });
});

describe('Processor attachments', () => {
  it('uploads mail attachments and links them to the task', async () => {
    const { kaneo, stageDraftAsset, putUploadBytes, finalizeDraftAsset, createTask } = fakeKaneo();
    const att = attachment();
    const outcome = await new Processor(kaneo).process(mail({ attachments: [att] }));

    expect(outcome).toEqual({ state: 'accepted', taskId: 't1' });
    expect(stageDraftAsset).toHaveBeenCalledWith('p1', att);
    expect(putUploadBytes).toHaveBeenCalledWith('https://upload.example/put', att.content, {
      'Content-Type': 'image/png',
    });
    expect(finalizeDraftAsset).toHaveBeenCalledWith('p1', att, 'k1');
    expect(createTask).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        draftAssetIds: ['a1'],
        description: expect.stringContaining(
          '<kaneo-attachment url="https://kaneo.example.com/api/asset/a1" filename="logo.png"',
        ),
      }),
    );
  });

  it('appends the attachment card after the original body', async () => {
    const { kaneo, createTask } = fakeKaneo();
    await new Processor(kaneo).process(mail({ description: 'Brief', attachments: [attachment()] }));

    expect(createTask).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ description: expect.stringMatching(/^Brief\n<kaneo-attachment/) }),
    );
  });

  it('notes skipped oversize attachments instead of uploading them', async () => {
    const { kaneo, stageDraftAsset, createTask } = fakeKaneo();
    const processor = new Processor(kaneo, { maxAttachmentMb: 25 });
    const big = attachment({ filename: 'huge.tif', contentType: 'image/tiff', size: 40 * 1024 * 1024 });
    const outcome = await processor.process(mail({ attachments: [big] }));

    expect(outcome).toEqual({ state: 'accepted', taskId: 't1' });
    expect(stageDraftAsset).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        description: expect.stringContaining('skipped attachment "huge.tif": exceeds the 25 MB limit'),
      }),
    );
  });

  it('retries when attachment staging fails temporarily', async () => {
    const { kaneo, stageDraftAsset, createTask } = fakeKaneo();
    const processor = new Processor(kaneo);
    stageDraftAsset.mockRejectedValueOnce(new KaneoError('Image uploads are not configured', 503));
    const outcome = await processor.process(mail({ attachments: [attachment()] }));

    expect(outcome).toEqual({ state: 'retry', reason: 'Image uploads are not configured' });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('rejects when attachment staging fails permanently', async () => {
    const { kaneo, stageDraftAsset } = fakeKaneo();
    stageDraftAsset.mockRejectedValueOnce(new KaneoError('Invalid upload', 400));
    expect(await new Processor(kaneo).process(mail({ attachments: [attachment()] }))).toEqual({
      state: 'rejected',
      reason: 'Invalid upload',
    });
  });

  it('escapes quotes and ampersands in attachment attributes', async () => {
    const { kaneo, createTask } = fakeKaneo();
    const weird = attachment({ filename: 'a&b "v2".png' });
    await new Processor(kaneo).process(mail({ attachments: [weird] }));

    expect(createTask).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        description: expect.stringContaining('filename="a&amp;b &quot;v2&quot;.png"'),
      }),
    );
  });
});
