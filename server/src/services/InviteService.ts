import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { AppError, ErrorCodes } from '../utils/AppError';
import { AuthSession, issueSession } from './AuthService';
import { dataService } from './DataService';
import { mailService } from './MailService';
import { hashToken, newOpaqueToken } from './TokenService';

/** Roles an owner or admin may hand out. Ownership moves only by transfer (F10.2). */
export const INVITABLE_ROLES = ['admin', 'editor', 'reviewer', 'viewer'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const INVITE_TTL_DAYS = 7;
const MAX_PAGE = 50;

export interface InviteView {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvite {
  invite: InviteView;
  /** Returned to the inviter so the link can also be copied and shared directly. */
  inviteToken: string;
  acceptUrl: string;
}

export interface InvitePreview {
  firmName: string;
  email: string;
  role: string;
  expiresAt: string;
  /** Whether the invited email already has a MedexRegAI account (sign in vs. create). */
  accountExists: boolean;
}

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  role_id: string;
  firm_name: string;
  expires_at: string;
}

function notFound(): AppError {
  return new AppError(404, ErrorCodes.INVITE_NOT_FOUND, 'This invitation is invalid, expired or has already been used');
}

/** Opaque cursor for keyset pagination: "<createdAt ISO>|<id>", base64url. */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'cursor is invalid');
  }
  return { createdAt, id };
}

export class InviteService {
  /** Owner/admin invites someone to the firm with a role; emails a single-use link. */
  async create(ctx: { orgId: string; userId: string }, input: { email: string; role: InvitableRole }): Promise<CreatedInvite> {
    const token = newOpaqueToken();
    const result = await dataService.transaction(ctx, async (tx) => {
      const members = await tx.query<{ status: string }>(
        'memberships',
        `SELECT m.status FROM memberships m JOIN user_profiles p ON p.user_id = m.user_id
          WHERE m.org_id = $1 AND p.email = $2`,
        [ctx.orgId, input.email]
      );
      if (members[0]?.status === 'active') {
        throw new AppError(409, ErrorCodes.ALREADY_MEMBER, 'This person is already a member of your firm');
      }
      await tx.query('invites', 'SAVEPOINT create_invite');
      try {
        const rows = await tx.query<{ id: string; email: string; expires_at: string; created_at: string; firm_name: string }>(
          'invites',
          `INSERT INTO invites (org_id, email, role_id, token_hash, invited_by, expires_at)
           SELECT $1, $2, r.id, $3, $4, now() + make_interval(days => $6)
             FROM roles r WHERE r.key = $5 AND r.org_id IS NULL
           RETURNING id, email, expires_at, created_at, (SELECT name FROM orgs WHERE id = $1) AS firm_name`,
          [ctx.orgId, input.email, token.hash, ctx.userId, input.role, INVITE_TTL_DAYS]
        );
        return rows[0];
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'invites_open_email_uq') {
          await tx.query('invites', 'ROLLBACK TO SAVEPOINT create_invite');
          throw new AppError(409, ErrorCodes.INVITE_PENDING, 'An invitation to this email is already pending');
        }
        throw err;
      }
    });

    const acceptUrl = `${config.appBaseUrl}/invite/${encodeURIComponent(token.token)}`;
    await mailService.send({
      to: input.email,
      subject: `You're invited to ${result.firm_name} on MedexRegAI`,
      text: `You have been invited to join ${result.firm_name} on MedexRegAI as ${input.role}.\n\nAccept the invitation (valid ${INVITE_TTL_DAYS} days, single use):\n${acceptUrl}`,
    });
    return {
      invite: { id: result.id, email: result.email, role: input.role, expiresAt: result.expires_at, createdAt: result.created_at },
      inviteToken: token.token,
      acceptUrl,
    };
  }

  /** Open (not accepted, revoked or expired) invites of the firm, newest first, keyset-paginated. */
  async listOpen(ctx: { orgId: string; userId: string }, limit: number, cursor?: string): Promise<{ items: InviteView[]; nextCursor: string | null }> {
    const size = Math.min(Math.max(limit, 1), MAX_PAGE);
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await dataService.query<{ id: string; email: string; role: string; expires_at: Date; created_at: Date }>(
      ctx,
      'invites',
      `SELECT i.id, i.email, r.key AS role, i.expires_at, i.created_at
         FROM invites i JOIN roles r ON r.id = i.role_id
        WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          AND ($2::timestamptz IS NULL OR (i.created_at, i.id) < ($2::timestamptz, $3::uuid))
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $4`,
      [ctx.orgId, after?.createdAt ?? null, after?.id ?? null, size + 1]
    );
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: new Date(r.expires_at).toISOString(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > size && last ? encodeCursor(new Date(last.created_at).toISOString(), last.id) : null,
    };
  }

  /** What the invite page shows before accepting. Public: the token is the credential. */
  async preview(token: string): Promise<InvitePreview> {
    const rows = await dataService.transaction({}, (tx) =>
      tx.lookupByToken<InviteRow & { account_exists: boolean }>(
      'invites',
      `SELECT i.id, i.org_id, i.email, r.key AS role, i.role_id, o.name AS firm_name, i.expires_at,
              EXISTS (SELECT 1 FROM user_profiles p WHERE p.email = i.email) AS account_exists
         FROM invites i JOIN roles r ON r.id = i.role_id JOIN orgs o ON o.id = i.org_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          AND i.expires_at > now() AND o.status = 'active'`,
      [hashToken(token)]
    ));
    const row = rows[0];
    if (!row) {
      throw notFound();
    }
    return {
      firmName: row.firm_name,
      email: row.email,
      role: row.role,
      expiresAt: new Date(row.expires_at).toISOString(),
      accountExists: row.account_exists,
    };
  }

  /**
   * Accept: a new person creates their account (fullName + password); someone who
   * already has an account confirms with their password. Either way they join the
   * firm with the invited role and are signed in to it.
   */
  async accept(token: string, input: { fullName?: string; password: string }): Promise<AuthSession> {
    return dataService.transaction({}, async (tx) => {
      const invites = await tx.lookupByToken<InviteRow>(
        'invites',
        `SELECT i.id, i.org_id, i.email, r.key AS role, i.role_id, o.name AS firm_name, i.expires_at
           FROM invites i JOIN roles r ON r.id = i.role_id JOIN orgs o ON o.id = i.org_id
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > now() AND o.status = 'active'
          FOR UPDATE OF i`,
        [hashToken(token)]
      );
      const invite = invites[0];
      if (!invite) {
        throw notFound();
      }

      const existing = await tx.query<{ id: string; full_name: string; status: string; password_hash: string | null }>(
        'user_profiles',
        `SELECT u.id, p.full_name, p.status, u.password_hash
           FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE p.email = $1`,
        [invite.email]
      );
      let userId: string;
      let fullName: string;
      if (existing[0]) {
        const ok = existing[0].password_hash ? await bcrypt.compare(input.password, existing[0].password_hash) : false;
        if (!ok || existing[0].status !== 'active') {
          throw new AppError(401, ErrorCodes.INVALID_CREDENTIALS, 'Email or password is incorrect');
        }
        userId = existing[0].id;
        fullName = existing[0].full_name;
      } else {
        if (!input.fullName) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'fullName is required to create your account', [
            { field: 'fullName', message: 'fullName is required to create your account' },
          ]);
        }
        const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
        const [user] = await tx.query<{ id: string }>('users', 'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [
          invite.email,
          passwordHash,
        ]);
        await tx.query('user_profiles', 'INSERT INTO user_profiles (user_id, email, full_name, email_verified_at) VALUES ($1, $2, $3, now())', [
          user.id,
          invite.email,
          input.fullName,
        ]);
        userId = user.id;
        fullName = input.fullName;
      }

      await tx.setOrg(invite.org_id);
      const joined = await tx.query<{ id: string }>(
        'memberships',
        `INSERT INTO memberships (org_id, user_id, role_id, invited_by)
         SELECT $1, $2, $3, invited_by FROM invites WHERE id = $4
         ON CONFLICT (org_id, user_id) DO UPDATE
           SET role_id = EXCLUDED.role_id, status = 'active', updated_at = now()
           WHERE memberships.status <> 'active'
         RETURNING id`,
        [invite.org_id, userId, invite.role_id, invite.id]
      );
      if (!joined[0]) {
        throw new AppError(409, ErrorCodes.ALREADY_MEMBER, 'You are already a member of this firm');
      }
      await tx.query('invites', 'UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
      const orgs = await tx.query<{ slug: string }>('orgs', 'SELECT slug FROM orgs WHERE id = $1', [invite.org_id]);
      return issueSession(
        tx,
        { id: userId, email: invite.email, fullName },
        { id: invite.org_id, name: invite.firm_name, slug: orgs[0].slug },
        invite.role
      );
    });
  }
}

export const inviteService = new InviteService();
