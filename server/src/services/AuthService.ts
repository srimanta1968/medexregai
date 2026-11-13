import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { config } from '../config/env';
import { MfaChallenge, mfaService } from './MfaService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { dataService, Tx } from './DataService';
import { mailService } from './MailService';
import { accessTokenTtlSeconds, hashToken, newOpaqueToken, signAccessToken } from './TokenService';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
}

export interface AuthOrg {
  id: string;
  name: string;
  slug: string;
}

export interface AuthSession {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
  org: AuthOrg;
  role: string;
}

const RESET_TOKEN_TTL_MINUTES = 60;
// A real bcrypt hash of a random string, compared against when the email is unknown,
// so a failed login takes the same time whether or not the account exists.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 12);

/** A URL-safe slug from the firm name plus a short random suffix (slugs are unique). */
export function firmSlug(firmName: string): string {
  const base = firmName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop accents: "Ünïcode" -> "unicode"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'firm'}-${randomBytes(3).toString('hex')}`;
}

/** Create a refresh token and access token for a user in a firm (shared with invite accept). */
export async function issueSession(tx: Tx, user: AuthUser, org: AuthOrg, role: string, familyId?: string): Promise<AuthSession> {
  const refresh = newOpaqueToken();
  await tx.query(
    'refresh_tokens',
    `INSERT INTO refresh_tokens (user_id, org_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [user.id, org.id, familyId ?? randomUUID(), refresh.hash, config.jwt.refreshTtlDays]
  );
  return {
    token: signAccessToken({ userId: user.id, orgId: org.id, role }),
    refreshToken: refresh.token,
    expiresIn: accessTokenTtlSeconds(),
    user,
    org,
    role,
  };
}

export interface MembershipRow {
  org_id: string;
  org_name: string;
  org_slug: string;
  role: string;
}

/** The firm a user lands in after signing in: their oldest active membership in an active firm (multi-firm switching comes later). */
export async function primaryMembership(tx: Tx, userId: string): Promise<MembershipRow | undefined> {
  const rows = await tx.query<MembershipRow>(
    'orgs',
    `SELECT o.id AS org_id, o.name AS org_name, o.slug AS org_slug, r.key AS role
       FROM orgs o
       JOIN LATERAL (
         SELECT m.role_id FROM memberships m
          WHERE m.org_id = o.id AND m.user_id = $1 AND m.status = 'active'
       ) m ON true
       JOIN roles r ON r.id = m.role_id
      WHERE o.status = 'active'
      ORDER BY o.created_at
      LIMIT 1`,
    [userId]
  );
  return rows[0];
}

/**
 * Create an account, its firm workspace and the owner membership inside `tx`, and
 * sign the person in. passwordHash is null for accounts that only sign in through
 * Google/Microsoft (password login then always fails for them).
 */
export async function createFirmOwner(
  tx: Tx,
  input: { fullName: string; email: string; passwordHash: string | null; firmName: string; emailVerified: boolean }
): Promise<AuthSession & { userId: string }> {
  await tx.query('users', 'SAVEPOINT create_firm_owner');
  let userId: string;
  try {
    const [user] = await tx.query<{ id: string }>('users', 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [
      input.email,
      input.passwordHash,
    ]);
    userId = user.id;
    await tx.query(
      'user_profiles',
      'INSERT INTO user_profiles (user_id, email, full_name, email_verified_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)',
      [user.id, input.email, input.fullName, input.emailVerified]
    );
  } catch (err) {
    await tx.query('users', 'ROLLBACK TO SAVEPOINT create_firm_owner');
    if ((err as { constraint?: string }).constraint === 'user_profiles_email_uq') {
      throw new AppError(409, ErrorCodes.EMAIL_TAKEN, 'An account with this email already exists');
    }
    throw err;
  }
  const [org] = await tx.query<AuthOrg>('orgs', 'INSERT INTO orgs (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id, name, slug', [
    input.firmName,
    firmSlug(input.firmName),
    userId,
  ]);
  await tx.setOrg(org.id);
  await tx.query(
    'memberships',
    `INSERT INTO memberships (org_id, user_id, role_id)
     SELECT $1, $2, id FROM roles WHERE key = 'owner' AND org_id IS NULL`,
    [org.id, userId]
  );
  const session = await issueSession(tx, { id: userId, email: input.email, fullName: input.fullName }, org, 'owner');
  return { ...session, userId };
}

export class AuthService {
  /** Create the account, the firm workspace and the owner membership, atomically. */
  async register(input: { fullName: string; email: string; password: string; firmName: string }): Promise<AuthSession> {
    const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
    const { userId: _userId, ...session } = await dataService.transaction({}, (tx) =>
      createFirmOwner(tx, { fullName: input.fullName, email: input.email, passwordHash, firmName: input.firmName, emailVerified: false })
    );
    return session;
  }

  /**
   * Password sign-in. With two-step sign-in on (F4.4), a correct password gives a short-lived
   * challenge instead of a session; completeMfa trades it, with a code, for the session.
   */
  async login(input: { email: string; password: string }): Promise<AuthSession | MfaChallenge> {
    return dataService.transaction({}, async (tx) => {
      const rows = await tx.query<{ id: string; email: string; full_name: string; status: string; password_hash: string | null }>(
        'user_profiles',
        `SELECT u.id, p.email, p.full_name, p.status, u.password_hash
           FROM user_profiles p JOIN users u ON u.id = p.user_id
          WHERE p.email = $1`,
        [input.email]
      );
      const row = rows[0];
      const valid = await bcrypt.compare(input.password, row?.password_hash ?? DUMMY_HASH);
      // One message for every failure, so the response never reveals which accounts exist.
      if (!row || !row.password_hash || !valid || row.status !== 'active') {
        throw new AppError(401, ErrorCodes.INVALID_CREDENTIALS, 'Email or password is incorrect');
      }
      const membership = await primaryMembership(tx, row.id);
      if (!membership) {
        throw new AppError(403, ErrorCodes.NO_ACTIVE_MEMBERSHIP, 'This account is not an active member of any firm');
      }
      if (await mfaService.isEnabled(row.id)) return mfaService.challenge(row.id);
      await tx.query('user_profiles', 'UPDATE user_profiles SET last_login_at = now() WHERE user_id = $1', [row.id]);
      return issueSession(
        tx,
        { id: row.id, email: row.email, fullName: row.full_name },
        { id: membership.org_id, name: membership.org_name, slug: membership.org_slug },
        membership.role
      );
    });
  }

  /** Second step of password sign-in: the challenge's user, after a correct code, gets a session. */
  async completeMfa(userId: string): Promise<AuthSession> {
    return dataService.transaction({}, async (tx) => {
      const users = await tx.query<{ email: string; full_name: string; status: string }>(
        'user_profiles',
        'SELECT email, full_name, status FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      const membership = await primaryMembership(tx, userId);
      if (!users[0] || users[0].status !== 'active' || !membership) {
        throw new AppError(401, ErrorCodes.INVALID_MFA_TOKEN, 'The sign-in step has expired. Sign in again.');
      }
      await tx.query('user_profiles', 'UPDATE user_profiles SET last_login_at = now() WHERE user_id = $1', [userId]);
      return issueSession(
        tx,
        { id: userId, email: users[0].email, fullName: users[0].full_name },
        { id: membership.org_id, name: membership.org_name, slug: membership.org_slug },
        membership.role
      );
    });
  }

  /**
   * Exchange a refresh token for a new pair. Each refresh token works once; presenting
   * one that was already used revokes its whole family (stolen-token detection).
   */
  async refresh(refreshToken: string): Promise<AuthSession> {
    const invalid = new AppError(401, ErrorCodes.INVALID_REFRESH_TOKEN, 'Refresh token is invalid or expired');
    const outcome = await dataService.transaction({}, async (tx) => {
      const rows = await tx.query<{ id: string; user_id: string; family_id: string; expired: boolean; used_at: string | null; revoked_at: string | null }>(
        'refresh_tokens',
        `SELECT id, user_id, family_id, expires_at <= now() AS expired, used_at, revoked_at
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(refreshToken)]
      );
      const current = rows[0];
      if (!current || current.revoked_at || current.expired) {
        return null;
      }
      if (current.used_at) {
        // Reuse of a rotated token: assume theft and end every session in this family.
        await tx.query('refresh_tokens', 'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
          current.family_id,
        ]);
        return 'reused' as const;
      }
      await tx.query('refresh_tokens', 'UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [current.id]);
      const users = await tx.query<{ email: string; full_name: string; status: string }>(
        'user_profiles',
        'SELECT email, full_name, status FROM user_profiles WHERE user_id = $1',
        [current.user_id]
      );
      const membership = await primaryMembership(tx, current.user_id);
      if (!users[0] || users[0].status !== 'active' || !membership) {
        return null;
      }
      return issueSession(
        tx,
        { id: current.user_id, email: users[0].email, fullName: users[0].full_name },
        { id: membership.org_id, name: membership.org_name, slug: membership.org_slug },
        membership.role,
        current.family_id
      );
    });
    // Thrown outside the transaction so the family revocation above is committed.
    if (outcome === null || outcome === 'reused') {
      throw invalid;
    }
    return outcome;
  }

  /** End the session the refresh token belongs to (its whole rotation family). */
  async logout(userId: string, refreshToken: string): Promise<void> {
    await dataService.query(
      {},
      'refresh_tokens',
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2)`,
      [hashToken(refreshToken), userId]
    );
  }

  /** Always succeeds from the caller's view, so it cannot be used to probe for accounts. */
  async requestPasswordReset(email: string): Promise<void> {
    const reset = newOpaqueToken();
    const sent = await dataService.transaction({}, async (tx) => {
      const rows = await tx.query<{ user_id: string; full_name: string }>(
        'user_profiles',
        "SELECT user_id, full_name FROM user_profiles WHERE email = $1 AND status = 'active'",
        [email]
      );
      if (!rows[0]) {
        return null;
      }
      await tx.query(
        'password_reset_tokens',
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [rows[0].user_id, reset.hash, RESET_TOKEN_TTL_MINUTES]
      );
      return rows[0];
    });
    if (sent) {
      const link = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(reset.token)}`;
      await mailService.send({
        to: email,
        subject: 'Reset your MedexRegAI password',
        text: `Hello ${sent.full_name},\n\nUse this link to set a new password. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes and works once:\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
  }

  /** Set a new password with a valid, unused reset token; signs the user out everywhere. */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await dataService.transaction({}, async (tx) => {
      const rows = await tx.query<{ id: string; user_id: string }>(
        'password_reset_tokens',
        `SELECT id, user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(token)]
      );
      if (!rows[0]) {
        throw new AppError(400, ErrorCodes.INVALID_RESET_TOKEN, 'Reset link is invalid, expired or already used');
      }
      await tx.query('password_reset_tokens', 'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
      await tx.query('users', 'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, rows[0].user_id]);
      await tx.query('refresh_tokens', 'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
        rows[0].user_id,
      ]);
    });
  }

  /** The signed-in user and their current firm and role. */
  async me(userId: string, orgId: string): Promise<{ user: AuthUser; org: AuthOrg; role: string }> {
    return dataService.transaction({ orgId, userId }, async (tx) => {
      const rows = await tx.query<{ email: string; full_name: string; org_name: string; org_slug: string; role: string }>(
        'memberships',
        `SELECT p.email, p.full_name, o.name AS org_name, o.slug AS org_slug, r.key AS role
           FROM memberships m
           JOIN user_profiles p ON p.user_id = m.user_id
           JOIN orgs o ON o.id = m.org_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active' AND p.status = 'active'`,
        [orgId, userId]
      );
      if (!rows[0]) {
        throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid or expired token');
      }
      return {
        user: { id: userId, email: rows[0].email, fullName: rows[0].full_name },
        org: { id: orgId, name: rows[0].org_name, slug: rows[0].org_slug },
        role: rows[0].role,
      };
    });
  }
}

export const authService = new AuthService();
