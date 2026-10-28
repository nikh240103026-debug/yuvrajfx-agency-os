import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../config.ts';

export type Mail = { to: string; toName?: string | null; subject: string; text: string };

export type Mailer = {
  /** True only when SMTP credentials were provided through the environment. */
  readonly configured: boolean;
  readonly description: string;
  send(mail: Mail): Promise<{ messageId: string }>;
  verify(): Promise<{ ok: boolean; error?: string }>;
};

/** SMTP mailer from env config. Without config it refuses to send; the outbox then offers manual sending. */
export function createMailer(smtp: SmtpConfig | null): Mailer {
  if (!smtp) {
    return {
      configured: false,
      description: 'Email is off: SMTP is not configured.',
      async send() {
        throw new Error('SMTP is not configured. Copy the message and send it from your own email instead.');
      },
      async verify() {
        return { ok: false, error: 'SMTP is not configured.' };
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
  });
  return {
    configured: true,
    description: `SMTP ${smtp.host}:${smtp.port} as ${smtp.from}`,
    async send(mail) {
      const info = await transport.sendMail({
        from: smtp.from,
        to: mail.toName ? { name: mail.toName, address: mail.to } : mail.to,
        subject: mail.subject,
        text: mail.text,
      });
      return { messageId: String(info.messageId ?? '') };
    },
    async verify() {
      try {
        await transport.verify();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** In-memory mailer for tests: records messages instead of sending them. */
export function createRecordingMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    configured: true,
    description: 'Recording mailer (tests)',
    sent,
    async send(mail) {
      sent.push(mail);
      return { messageId: `test-${sent.length}` };
    },
    async verify() {
      return { ok: true };
    },
  };
}
