import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import { config, SsoProviderId, SsoProviderSettings } from '../config/env';
import { AppError, ErrorCodes } from '../utils/AppError';
import { AuthSession, createFirmOwner, issueSession, primaryMembership } from './AuthService';
import { dataService } from './DataService';
import { hashToken, newOpaqueToken } from './TokenService';

/** Why an SSO attempt failed; shown on the sign-in page as ?sso_error=<code>. */
export type SsoFailure =
  | 'cancelled'
  | 'state_mismatch'
  | 'provider_error'
  | 'email_unverified'
  | 'no_account'
  | 'no_membership';

export class SsoError extends Error {
  constructor(public readonly reason: SsoFailure, message: string) {
    super(message);
    this.name = 'SsoError';
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Login attempt carried in a signed, httpOnly cookie between start and callback. */
interface PendingLogin {
  provider: SsoProviderId;
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export const SSO_COOKIE = 'medexregai_sso';
const PENDING_TTL_SECONDS = 600;
const HANDOFF_TTL_SECONDS = 120;
const SIGNUP_TTL_MINUTES = 15;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sign(value: string): string {
  return createHmac('sha256', config.jwt.secret).update(`sso:${value}`).digest('base64url');
}

/** Encode the pending login as "<payload>.<hmac>" (tamper-evident, stateless). */
export function sealPending(pending: PendingLogin): string {
  const payload = b64url(Buffer.from(JSON.stringify(pending)));
  return `${payload}.${sign(payload)}`;
}

export function openPending(raw: string | undefined): PendingLogin | null {
  if (!raw) {
    return null;
  }
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) {
    return null;
  }
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const pending = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PendingLogin;
    return pending.exp > Math.floor(Date.now() / 1000) ? pending : null;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) {
    throw new SsoError('provider_error', `Identity provider returned ${response.status} for ${new URL(url).pathname}`);
  }
  return (await response.json()) as T;
}

const SIGNUP_EXPIRED = 'This sign-up link has expired. Please sign in with Google or Microsoft again.';

/** A provider-verified identity with no account yet. */
interface PendingSignup {
  provider: SsoProviderId;
  subject: string;
  email: string;
  fullName: string | null;
}

export class SsoService {
  private readonly discovery = new Map<SsoProviderId, { doc: Discovery; at: number }>();
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  /** Providers the sign-in page should offer. */
  enabledProviders(): { id: SsoProviderId; name: string }[] {
    return config.sso.map((p) => ({ id: p.id, name: p.displayName }));
  }

  provider(id: string): SsoProviderSettings {
    const provider = config.sso.find((p) => p.id === id);
    if (!provider) {
      throw new AppError(404, ErrorCodes.SSO_PROVIDER_DISABLED, `Sign-in with ${id} is not enabled`);
    }
    return provider;
  }

  redirectUri(provider: SsoProviderId): string {
    // Same origin as the web app (Vite proxies /api in development), so the cookie set
    // at start is sent back on the callback.
    return `${config.appBaseUrl}/api/auth/sso/${provider}/callback`;
  }

  private async discover(provider: SsoProviderSettings): Promise<Discovery> {
    const cached = this.discovery.get(provider.id);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
      return cached.doc;
    }
    const doc = await fetchJson<Discovery>(`${provider.issuer}/.well-known/openid-configuration`);
    this.discovery.set(provider.id, { doc, at: Date.now() });
    return doc;
  }

  /** Build the provider authorize URL (code flow + PKCE S256) and the cookie to set. */
  async start(id: string): Promise<{ url: string; cookie: string }> {
    const provider = this.provider(id);
    const doc = await this.discover(provider);
    const pending: PendingLogin = {
      provider: provider.id,
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
    };
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: this.redirectUri(provider.id),
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString(), cookie: sealPending(pending) };
  }

  /**
   * Finish the provider redirect: check state, exchange the code, verify the ID token
   * (signature, issuer, audience, expiry, nonce), resolve the account and return a
   * one-time handoff code for the web app.
   */
  async callback(id: string, query: Record<string, unknown>, cookie: string | undefined): Promise<{ kind: 'signin' | 'signup'; code: string }> {
    const provider = this.provider(id);
    if (typeof query.error === 'string') {
      throw new SsoError('cancelled', `Provider returned error ${query.error}`);
    }
    const pending = openPending(cookie);
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (!pending || pending.provider !== provider.id || !state || !safeEqual(state, pending.state) || !code) {
      throw new SsoError('state_mismatch', 'SSO state is missing, expired or does not match');
    }

    const doc = await this.discover(provider);
    const tokens = await fetchJson<{ id_token?: string }>(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(provider.id),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!tokens.id_token) {
      throw new SsoError('provider_error', 'Token response has no id_token');
    }
    const claims = await this.verifyIdToken(provider, doc, tokens.id_token, pending.nonce);
    const resolved = await this.resolveUser(provider.id, claims);
    if ('userId' in resolved) {
      return { kind: 'signin', code: await this.createHandoff(resolved.userId) };
    }
    return { kind: 'signup', code: await this.createSignup(resolved) };
  }

  private async verifyIdToken(provider: SsoProviderSettings, doc: Discovery, idToken: string, nonce: string): Promise<JWTPayload> {
    let keys = this.jwks.get(doc.jwks_uri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: HTTP_TIMEOUT_MS });
      this.jwks.set(doc.jwks_uri, keys);
    }
    try {
      const { payload } = await jwtVerify(idToken, keys, { audience: provider.clientId, clockTolerance: 60 });
      // Multi-tenant Microsoft endpoints publish the issuer as a template per tenant.
      const expectedIssuer = doc.issuer.replace('{tenantid}', typeof payload.tid === 'string' ? payload.tid : '{tenantid}');
      if (payload.iss !== expectedIssuer) {
        throw new Error(`unexpected issuer ${payload.iss}`);
      }
      if (payload.nonce !== nonce) {
        throw new Error('nonce mismatch');
      }
      return payload;
    } catch (err) {
      throw new SsoError('provider_error', `ID token rejected: ${(err as Error).message}`);
    }
  }

  /**
   * Find the MedexRegAI account for these claims. A linked identity (provider +
   * subject) always wins. Otherwise the provider must vouch for the email before it
   * is linked to an existing account: Google via email_verified, Microsoft via the
   * xms_edov optional claim (domain-verified email; enable it on the app
   * registration). SSO signs people IN; it never creates accounts or firms.
   */
  private async resolveUser(provider: SsoProviderId, claims: JWTPayload): Promise<{ userId: string } | PendingSignup> {
    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    const rawEmail = typeof claims.email === 'string' ? claims.email : '';
    const email = rawEmail.trim().toLowerCase();
    if (!subject) {
      throw new SsoError('provider_error', 'ID token has no subject');
    }
    return dataService.transaction({}, async (tx) => {
      const linked = await tx.query<{ user_id: string }>(
        'user_identities',
        'UPDATE user_identities SET last_used_at = now() WHERE provider = $1 AND subject = $2 RETURNING user_id',
        [provider, subject]
      );
      if (linked[0]) {
        return { userId: linked[0].user_id };
      }
      const verified = provider === 'google' ? claims.email_verified === true : claims.xms_edov === true || claims.xms_edov === '1';
      if (!email || !verified) {
        throw new SsoError('email_unverified', `${provider} did not confirm the email address`);
      }
      const users = await tx.query<{ user_id: string; status: string }>('user_profiles', 'SELECT user_id, status FROM user_profiles WHERE email = $1', [
        email,
      ]);
      if (!users[0]) {
        // New person whose email the provider vouched for: offer to create a firm workspace.
        return { provider, subject, email, fullName: typeof claims.name === 'string' ? claims.name.slice(0, 200) : null };
      }
      if (users[0].status !== 'active') {
        throw new SsoError('no_account', 'No active MedexRegAI account for this email');
      }
      await tx.query(
        'user_identities',
        `INSERT INTO user_identities (user_id, provider, subject, email, last_used_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, provider) DO UPDATE SET subject = EXCLUDED.subject, email = EXCLUDED.email, last_used_at = now()`,
        [users[0].user_id, provider, subject, email]
      );
      return { userId: users[0].user_id };
    });
  }

  private async createSignup(p: PendingSignup): Promise<string> {
    const code = newOpaqueToken();
    await dataService.query(
      {},
      'sso_signups',
      `INSERT INTO sso_signups (token_hash, provider, subject, email, full_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
      [code.hash, p.provider, p.subject, p.email, p.fullName, SIGNUP_TTL_MINUTES]
    );
    return code.token;
  }

  /** What the sign-up page shows: the provider-verified email and name. Does not use up the code. */
  async previewSignup(code: string): Promise<{ provider: string; email: string; fullName: string | null }> {
    const rows = await dataService.transaction({}, (tx) =>
      tx.lookupByToken<{ provider: string; email: string; full_name: string | null }>(
        'sso_signups',
        'SELECT provider, email, full_name FROM sso_signups WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
        [hashToken(code)]
      )
    );
    if (!rows[0]) {
      throw new AppError(401, ErrorCodes.INVALID_SSO_CODE, SIGNUP_EXPIRED);
    }
    return { provider: rows[0].provider, email: rows[0].email, fullName: rows[0].full_name };
  }

  /**
   * Create the account (no password: it signs in through the provider), link the
   * identity, create the firm with this person as owner and sign them in. The code
   * is consumed in the same transaction, so it works once.
   */
  async completeSignup(code: string, input: { fullName: string; firmName: string }): Promise<AuthSession> {
    return dataService.transaction({}, async (tx) => {
      const rows = await tx.lookupByToken<{ provider: string; subject: string; email: string }>(
        'sso_signups',
        `UPDATE sso_signups SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING provider, subject, email`,
        [hashToken(code)]
      );
      const signup = rows[0];
      if (!signup) {
        throw new AppError(401, ErrorCodes.INVALID_SSO_CODE, SIGNUP_EXPIRED);
      }
      const { userId, ...session } = await createFirmOwner(tx, {
        fullName: input.fullName,
        email: signup.email,
        passwordHash: null,
        firmName: input.firmName,
        emailVerified: true,
      });
      await tx.query(
        'user_identities',
        'INSERT INTO user_identities (user_id, provider, subject, email, last_used_at) VALUES ($1, $2, $3, $4, now())',
        [userId, signup.provider, signup.subject, signup.email]
      );
      return session;
    });
  }

  private async createHandoff(userId: string): Promise<string> {
    const handoff = newOpaqueToken();
    await dataService.query(
      {},
      'sso_handoffs',
      'INSERT INTO sso_handoffs (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))',
      [handoff.hash, userId, HANDOFF_TTL_SECONDS]
    );
    return handoff.token;
  }

  /** Trade the one-time handoff code for a session in the user's primary firm. */
  async exchange(code: string): Promise<AuthSession> {
    return dataService.transaction({}, async (tx) => {
      const rows = await tx.lookupByToken<{ user_id: string }>(
        'sso_handoffs',
        `UPDATE sso_handoffs SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [hashToken(code)]
      );
      if (!rows[0]) {
        throw new AppError(401, ErrorCodes.INVALID_SSO_CODE, 'This sign-in link has expired. Please try again.');
      }
      const userId = rows[0].user_id;
      const profiles = await tx.query<{ email: string; full_name: string; status: string }>(
        'user_profiles',
        'SELECT email, full_name, status FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      const profile = profiles[0];
      if (!profile || profile.status !== 'active') {
        throw new AppError(401, ErrorCodes.INVALID_SSO_CODE, 'This sign-in link has expired. Please try again.');
      }
      const membership = await primaryMembership(tx, userId);
      if (!membership) {
        throw new AppError(403, ErrorCodes.NO_ACTIVE_MEMBERSHIP, 'This account is not an active member of any firm');
      }
      await tx.query('user_profiles', 'UPDATE user_profiles SET last_login_at = now() WHERE user_id = $1', [userId]);
      return issueSession(
        tx,
        { id: userId, email: profile.email, fullName: profile.full_name },
        { id: membership.org_id, name: membership.org_name, slug: membership.org_slug },
        membership.role
      );
    });
  }
}

export const ssoService = new SsoService();
