import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config/env';

/**
 * Authenticated encryption for secrets we must store but never show again (firm
 * AI provider keys, later OAuth refresh tokens). AES-256-GCM with ENCRYPTION_KEY.
 *
 * `context` is bound as additional authenticated data (e.g. "firm-provider:<org>:<id>"),
 * so a ciphertext copied onto another firm's row fails to decrypt.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url. The version allows rotation to a
 * KMS-held key later without a flag day.
 */
const VERSION = 'v1';

function key(): Buffer {
  return Buffer.from(config.encryptionKey, 'hex');
}

export function sealSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string, context: string): string {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** What may be shown about a secret: its last four characters. */
export const secretHint = (plaintext: string): string => plaintext.slice(-4);
