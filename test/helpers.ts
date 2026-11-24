import { getLogger } from 'log4js';

export const silentLogger = (() => {
  const logger = getLogger('test');
  logger.level = 'off';
  return logger;
})();

export interface RawAttachment {
  /** Omit to test attachments without any filename metadata. */
  filename?: string;
  contentType: string;
  content: string;
}

/** Builds a raw RFC 822 message. */
export function rawMail(
  options: {
    subject?: string;
    headers?: Record<string, string>;
    body?: string;
    attachments?: RawAttachment[];
  } = {},
): string {
  const headers = [
    'From: Board <board@example.com>',
    'To: kaneo@example.com',
    `Subject: ${options.subject ?? 'Order new chairs'}`,
    'Date: Fri, 02 Oct 2026 12:00:00 +0200',
    'Message-ID: <test@example.com>',
    'MIME-Version: 1.0',
    ...Object.entries(options.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ];

  if (!options.attachments?.length) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', '', options.body ?? 'We need twenty new chairs.'].join(
      '\r\n',
    );
  }

  const boundary = 'kaneo-mailer-test';
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? 'We need twenty new chairs.',
  ];
  for (const attachment of options.attachments) {
    const typeLine =
      attachment.filename === undefined
        ? `Content-Type: ${attachment.contentType}`
        : `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`;
    parts.push(
      `--${boundary}`,
      typeLine,
      'Content-Transfer-Encoding: base64',
      attachment.filename === undefined
        ? 'Content-Disposition: attachment'
        : `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      Buffer.from(attachment.content, 'utf8').toString('base64'),
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}
