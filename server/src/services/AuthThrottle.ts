import { createHash } from 'crypto';
import { config } from '../config/env';
import { dataService } from './DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F4.4 sign-in throttling (SOC 2 CC6-05), kept in Postgres so every API instance sees the same
 * counts. Failures are counted per account and per IP address over a window; at the limit the
 * route answers 429 RATE_LIMITED before checking the password, so guessing stops even when the
 * guess would have been right. A successful sign-in clears the account's failures.
 *
 * Subjects are SHA-256 hashes ("acct:<email>", "ip:<address>"): the table holds no emails or
 * addresses. Rows older than a day are pruned by the worker.
 */

export type ThrottleAction = 'login' | 'password_reset' | 'sso_exchange' | 'mfa';

interface Limit {
  max: number;
  windowMinutes: number;
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
export const accountSubject = (idOrEmail: string): string => hash(`acct:${idOrEmail.trim().toLowerCase()}`);
export const ipSubject = (ip: string | undefined): string => hash(`ip:${ip ?? 'unknown'}`);

/** Limits per action: per account (or user), and per IP address. */
export function limitsFor(action: ThrottleAction): { account: Limit | null; ip: Limit } {
  const t = config.authThrottle;
  switch (action) {
    case 'login':
      return { account: { max: t.accountFailures, windowMinutes: 15 }, ip: { max: t.ipFailures, windowMinutes: 15 } };
    case 'mfa':
      return { account: { max: 5, windowMinutes: 15 }, ip: { max: t.ipFailures, windowMinutes: 15 } };
    case 'sso_exchange':
      return { account: null, ip: { max: 30, windowMinutes: 15 } };
    case 'password_reset':
      // Every request counts (not only failures): a reset request cannot fail from the caller's view.
      return { account: { max: 5, windowMinutes: 60 }, ip: { max: 30, windowMinutes: 60 } };
  }
}

async function count(action: ThrottleAction, subject: string, limit: Limit, failuresOnly: boolean): Promise<number> {
  const rows = await dataService.query<{ n: number }>(
    {},
    'auth_attempts',
    `SELECT count(*)::int AS n FROM auth_attempts
      WHERE action = $1 AND subject = $2 AND at > now() - make_interval(mins => $3::int) AND ($4::boolean = false OR failed)`,
    [action, subject, limit.windowMinutes, failuresOnly],
  );
  return Number(rows[0]?.n ?? 0);
}

const tooMany = (minutes: number): AppError =>
  new AppError(429, ErrorCodes.RATE_LIMITED, `Too many attempts. Try again in ${minutes} minutes.`, [{ field: 'retryAfterSeconds', message: String(minutes * 60) }]);

export const authThrottle = {
  /** Throw 429 when the IP or the account is at its limit for this action. */
  async check(action: ThrottleAction, ip: string | undefined, account?: string): Promise<void> {
    const limits = limitsFor(action);
    const failuresOnly = action !== 'password_reset';
    if ((await count(action, ipSubject(ip), limits.ip, failuresOnly)) >= limits.ip.max) throw tooMany(limits.ip.windowMinutes);
    if (account && limits.account && (await count(action, accountSubject(account), limits.account, failuresOnly)) >= limits.account.max) {
      throw tooMany(limits.account.windowMinutes);
    }
  },

  /** True when the account is at its limit (used where a 429 would reveal that the account exists). */
  async accountLimited(action: ThrottleAction, account: string): Promise<boolean> {
    const limit = limitsFor(action).account;
    return !!limit && (await count(action, accountSubject(account), limit, action !== 'password_reset')) >= limit.max;
  },

  async record(action: ThrottleAction, ip: string | undefined, account: string | undefined, failed: boolean): Promise<void> {
    const subjects = [ipSubject(ip), ...(account ? [accountSubject(account)] : [])];
    await dataService.query(
      {},
      'auth_attempts',
      `INSERT INTO auth_attempts (action, subject, failed) SELECT $1, s, $3 FROM unnest($2::text[]) AS s`,
      [action, subjects, failed],
    );
  },

  /** After a successful sign-in the account starts again from zero (the IP count stays). */
  async clearAccount(action: ThrottleAction, account: string): Promise<void> {
    await dataService.query({}, 'auth_attempts', 'DELETE FROM auth_attempts WHERE action = $1 AND subject = $2', [action, accountSubject(account)]);
  },

  /** Worker: attempts older than a day are no longer needed. */
  async prune(): Promise<number> {
    const rows = await dataService.query<{ n: number }>(
      {},
      'auth_attempts',
      "WITH d AS (DELETE FROM auth_attempts WHERE at < now() - interval '1 day' RETURNING 1) SELECT count(*)::int AS n FROM d",
    );
    return Number(rows[0]?.n ?? 0);
  },
};
