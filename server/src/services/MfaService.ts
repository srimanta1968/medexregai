import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { config } from '../config/env';
import { dataService } from './DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { openSecret, sealSecret } from '../utils/secretBox';

/**
 * F4.4 second factor for password sign-in (SOC 2 CC6-04): an authenticator app using TOTP
 * (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps, one step of clock drift either way), plus ten
 * one-time recovery codes. A code is accepted once: the last step used is stored. Provider sign-in
 * (SSO) relies on the identity provider's own second factor and is not changed.
 *
 * After a correct password, an account with MFA gets a challenge token (5 minutes, its own JWT
 * audience, so it is never accepted as an access token) that POST /api/auth/mfa/verify trades,
 * with a code, for a session.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const RECOVERY_CODES = 10;
const ISSUER = 'medexregai';
const MFA_AUDIENCE = 'medexregai-mfa';
const CHALLENGE_SECONDS = 300;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The RFC 4226 HOTP value for one counter (TOTP uses the 30-second step as the counter). */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

const currentStep = (): number => Math.floor(Date.now() / 1000 / STEP_SECONDS);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const normaliseRecovery = (code: string): string => code.replace(/[\s-]/g, '').toLowerCase();
const context = (userId: string): string => `user-mfa:${userId}`;

/** The step a TOTP code matches (now, or one step either side), if any and not already used. */
function matchStep(secret: Buffer, code: string, lastUsed: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsed !== null && step <= lastUsed) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

interface MfaRow {
  secret_enc: string;
  enabled_at: Date | null;
  last_used_step: string | null;
  recovery_hashes: string[];
}

async function row(userId: string): Promise<MfaRow | undefined> {
  const [r] = await dataService.query<MfaRow>({}, 'user_mfa', 'SELECT secret_enc, enabled_at, last_used_step, recovery_hashes FROM user_mfa WHERE user_id = $1', [userId]);
  return r;
}

const invalidCode = (): AppError => new AppError(401, ErrorCodes.INVALID_MFA_CODE, 'The code is not correct or has already been used');

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export const mfaService = {
  async status(userId: string): Promise<{ enabled: boolean; pending: boolean; recoveryCodesLeft: number }> {
    const r = await row(userId);
    return { enabled: !!r?.enabled_at, pending: !!r && !r.enabled_at, recoveryCodesLeft: r?.enabled_at ? r.recovery_hashes.length : 0 };
  },

  async isEnabled(userId: string): Promise<boolean> {
    return !!(await row(userId))?.enabled_at;
  },

  /** Start (or restart) setup: a new secret, shown once, for the authenticator app. */
  async setup(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
    const r = await row(userId);
    if (r?.enabled_at) throw new AppError(409, ErrorCodes.MFA_ALREADY_ENABLED, 'Two-step sign-in is already on. Turn it off first to set up a new app.');
    const secret = randomBytes(20);
    await dataService.query(
      {},
      'user_mfa',
      `INSERT INTO user_mfa (user_id, secret_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled_at = NULL, last_used_step = NULL, recovery_hashes = '[]'::jsonb, updated_at = now()`,
      [userId, sealSecret(base32Encode(secret), context(userId))],
    );
    const b32 = base32Encode(secret);
    const label = encodeURIComponent(`MedexRegAI:${email}`);
    return { secret: b32, otpauthUrl: `otpauth://totp/${label}?secret=${b32}&issuer=MedexRegAI&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}` };
  },

  /** Confirm setup with a code from the app; returns the recovery codes, shown once. */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const r = await row(userId);
    if (!r) throw new AppError(409, ErrorCodes.MFA_NOT_SET_UP, 'Start setup first');
    if (r.enabled_at) throw new AppError(409, ErrorCodes.MFA_ALREADY_ENABLED, 'Two-step sign-in is already on');
    const step = matchStep(base32Decode(openSecret(r.secret_enc, context(userId))), code.trim(), null);
    if (step === null) throw invalidCode();
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      const raw = base32Encode(randomBytes(5)).toLowerCase();
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    });
    await dataService.query(
      {},
      'user_mfa',
      'UPDATE user_mfa SET enabled_at = now(), last_used_step = $2, recovery_hashes = $3::jsonb, updated_at = now() WHERE user_id = $1',
      [userId, step, JSON.stringify(codes.map((c) => sha256(normaliseRecovery(c))))],
    );
    return { recoveryCodes: codes };
  },

  /**
   * Check a sign-in code: a TOTP code (marked used) or a recovery code (removed). True when it
   * is accepted. Concurrent use of the same code is serialised by the row update.
   */
  async consume(userId: string, code: string): Promise<boolean> {
    return dataService.transaction({}, async (tx) => {
      const [r] = await tx.query<MfaRow>(
        'user_mfa',
        'SELECT secret_enc, enabled_at, last_used_step, recovery_hashes FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE',
        [userId],
      );
      if (!r) return false;
      const trimmed = code.trim();
      const step = matchStep(base32Decode(openSecret(r.secret_enc, context(userId))), trimmed, r.last_used_step === null ? null : Number(r.last_used_step));
      if (step !== null) {
        await tx.query('user_mfa', 'UPDATE user_mfa SET last_used_step = $2, updated_at = now() WHERE user_id = $1', [userId, step]);
        return true;
      }
      const h = sha256(normaliseRecovery(trimmed));
      if (!/^\d{6}$/.test(trimmed) && r.recovery_hashes.includes(h)) {
        await tx.query('user_mfa', 'UPDATE user_mfa SET recovery_hashes = $2::jsonb, updated_at = now() WHERE user_id = $1', [
          userId,
          JSON.stringify(r.recovery_hashes.filter((x) => x !== h)),
        ]);
        return true;
      }
      return false;
    });
  },

  /** Turn two-step sign-in off; needs a current code (or a recovery code). */
  async disable(userId: string, code: string): Promise<void> {
    if (!(await this.isEnabled(userId))) throw new AppError(409, ErrorCodes.MFA_NOT_SET_UP, 'Two-step sign-in is not on');
    if (!(await this.consume(userId, code))) throw invalidCode();
    await dataService.query({}, 'user_mfa', 'DELETE FROM user_mfa WHERE user_id = $1', [userId]);
  },

  challenge(userId: string): MfaChallenge {
    const mfaToken = jwt.sign({ typ: 'mfa' }, config.jwt.secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
      expiresIn: CHALLENGE_SECONDS,
    });
    return { mfaRequired: true, mfaToken, expiresIn: CHALLENGE_SECONDS };
  },

  /** The user a challenge token was issued to; 401 when it is invalid or expired. */
  challengeUser(token: string): string {
    try {
      const p = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: MFA_AUDIENCE }) as JwtPayload;
      if (p.typ !== 'mfa' || typeof p.sub !== 'string') throw new Error('not an mfa token');
      return p.sub;
    } catch {
      throw new AppError(401, ErrorCodes.INVALID_MFA_TOKEN, 'The sign-in step has expired. Sign in again.');
    }
  },
};
