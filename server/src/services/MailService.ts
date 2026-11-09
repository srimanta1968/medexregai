import { config } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outgoing email. The only transport so far is "log", which writes the message to
 * the server log for local development; config validation refuses it in production,
 * so a reset link can never silently vanish there. A real transport is added with
 * the notifications feature (F10.6).
 */
export class MailService {
  async send(message: MailMessage): Promise<void> {
    try {
      if (config.mail.transport === 'log') {
        console.log(
          ['----- email (MAIL_TRANSPORT=log) -----', `From: ${config.mail.from}`, `To: ${message.to}`, `Subject: ${message.subject}`, '', message.text, '----- end email -----'].join('\n')
        );
      }
    } catch (err) {
      // Delivery problems must not leak to the caller (e.g. reveal whether an account exists).
      console.error('Email delivery failed:', (err as Error).message);
    }
  }
}

export const mailService = new MailService();
