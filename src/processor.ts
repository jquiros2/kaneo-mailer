import { KaneoError, type Column, type KaneoClient } from './kaneo';
import { COLUMN_HEADER, PROJECT_HEADER, type TaskMail } from './message';

export const DEFAULT_COLUMN = 'mail';

/** Default cap for mail attachments, in megabytes. */
export const DEFAULT_MAX_ATTACHMENT_MB = 25;

export type Outcome =
  { state: 'accepted'; taskId: string } | { state: 'rejected'; reason: string } | { state: 'retry'; reason: string };

/** Serializes one attachment the way the Kaneo editor renders attachment cards. */
export function attachmentMarkup(url: string, filename: string, mimeType: string, size: number): string {
  return `\n<kaneo-attachment url="${escapeAttribute(url)}" filename="${escapeAttribute(filename)}" mime-type="${escapeAttribute(mimeType)}" size="${size}" />\n`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Picks the target column. An explicit header value matches a column id, slug or
 * name. Without one, the column called "mail" wins, else the first column on the board.
 */
export function resolveColumn(columns: Column[], wanted: string | null): Column | undefined {
  if (wanted !== null) {
    const needle = wanted.toLowerCase();
    return (
      columns.find((c) => c.id === wanted) ??
      columns.find((c) => c.slug === needle) ??
      columns.find((c) => c.name.toLowerCase() === needle)
    );
  }

  const sorted = [...columns].sort((a, b) => a.position - b.position);
  return sorted.find((c) => c.slug === DEFAULT_COLUMN || c.name.toLowerCase() === DEFAULT_COLUMN) ?? sorted[0];
}

export interface ProcessorDefaults {
  /** Project used when a message has no X-Kaneo-Project-Id header. */
  projectId?: string | null;
  /** Column id, slug or name used when a message has no X-Kaneo-Column header. */
  column?: string | null;
  /** Mail attachments above this many megabytes are skipped with a note on the task. 0 disables the cap. */
  maxAttachmentMb?: number;
}

export class Processor {
  private readonly columns = new Map<string, Promise<Column[]>>();

  constructor(
    private readonly kaneo: KaneoClient,
    private readonly defaults: ProcessorDefaults = {},
  ) {}

  async process(mail: TaskMail): Promise<Outcome> {
    const projectId = mail.projectId ?? this.defaults.projectId ?? null;
    if (!projectId) {
      return { state: 'rejected', reason: `missing ${PROJECT_HEADER} header` };
    }

    try {
      const columns = await this.columnsOf(projectId);
      const wanted = mail.column ?? this.defaults.column ?? null;
      const column = resolveColumn(columns, wanted);
      if (!column) {
        const reason =
          wanted === null
            ? `project ${projectId} has no columns`
            : `no column matching ${COLUMN_HEADER} "${wanted}" in project ${projectId}`;
        return { state: 'rejected', reason };
      }

      const { draftAssetIds, descriptionSuffix } = await this.uploadAttachments(projectId, mail.attachments);

      const task = await this.kaneo.createTask(projectId, {
        title: mail.title,
        description: mail.description + descriptionSuffix,
        status: column.slug,
        ...(mail.dueDate ? { dueDate: mail.dueDate } : {}),
        ...(draftAssetIds.length ? { draftAssetIds } : {}),
      });
      return { state: 'accepted', taskId: task.id };
    } catch (error) {
      if (error instanceof KaneoError) {
        return { state: error.permanent ? 'rejected' : 'retry', reason: error.message };
      }
      throw error;
    }
  }

  /**
   * Stages, uploads and finalizes every mail attachment, returning the asset ids
   * for the task plus the attachment-card markup to append to the description.
   * KaneoError propagates so process() can apply the permanent/retry policy; a
   * retried message re-uploads everything on the next poll (staged assets from a
   * failed attempt expire after 24 hours, so failed attempts leave nothing
   * permanent behind).
   */
  private async uploadAttachments(
    projectId: string,
    attachments: TaskMail['attachments'],
  ): Promise<{ draftAssetIds: string[]; descriptionSuffix: string }> {
    const limitMb = this.defaults.maxAttachmentMb ?? DEFAULT_MAX_ATTACHMENT_MB;
    const maxBytes = limitMb * 1024 * 1024;
    const draftAssetIds: string[] = [];
    let descriptionSuffix = '';

    for (const attachment of attachments) {
      if (maxBytes > 0 && attachment.size > maxBytes) {
        descriptionSuffix += `\n(skipped attachment "${attachment.filename}": exceeds the ${limitMb} MB limit)\n`;
        continue;
      }
      const staged = await this.kaneo.stageDraftAsset(projectId, attachment);
      await this.kaneo.putUploadBytes(staged.uploadUrl, attachment.content, staged.headers);
      const finalized = await this.kaneo.finalizeDraftAsset(projectId, attachment, staged.key);
      draftAssetIds.push(finalized.id);
      descriptionSuffix += attachmentMarkup(finalized.url, attachment.filename, attachment.contentType, attachment.size);
    }

    return { draftAssetIds, descriptionSuffix };
  }

  /** Columns are fetched once per project per run. */
  private columnsOf(projectId: string): Promise<Column[]> {
    let columns = this.columns.get(projectId);
    if (!columns) {
      columns = this.kaneo.getColumns(projectId);
      this.columns.set(projectId, columns);
    }
    return columns;
  }
}
