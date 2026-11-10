import { createHmac } from 'crypto';
import { config } from '../config/env';
import { AppError, ErrorCodes } from '../utils/AppError';
import { dataService } from './DataService';
import { mailService } from './MailService';

export interface PilotRequestInput {
  name: string;
  workEmail: string;
  firmName: string;
  role?: string;
  message: string;
}

/** HMAC of the client IP under a server secret: rate-limitable, not reversible to an IP. */
export function hashIp(ip: string): string {
  return createHmac('sha256', config.encryptionKey).update(`pilot-ip:${ip}`).digest('hex');
}

export class PilotRequestService {
  /**
   * Store a pilot request. Refuses more than PILOT_REQUESTS_PER_IP_PER_HOUR from one
   * hashed IP. Returns only the new id: nothing a visitor sends is echoed back.
   */
  async create(input: PilotRequestInput, meta: { ip: string; userAgent?: string }): Promise<{ id: string }> {
    const ipHash = hashIp(meta.ip);
    const { id } = await dataService.transaction({}, async (tx) => {
      // Serialise concurrent submissions from the same IP so the count below is exact.
      await tx.query('pilot_requests', 'SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);
      const [recent] = await tx.query<{ n: number }>(
        'pilot_requests',
        `SELECT count(*)::int AS n FROM pilot_requests
          WHERE source_ip_hash = $1 AND created_at > now() - interval '1 hour'`,
        [ipHash]
      );
      if (recent.n >= config.pilot.perIpPerHour) {
        throw new AppError(429, ErrorCodes.RATE_LIMITED, 'Too many requests. Please try again in an hour.');
      }
      const [row] = await tx.query<{ id: string }>(
        'pilot_requests',
        `INSERT INTO pilot_requests (name, work_email, firm_name, role, message, source_ip_hash, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [input.name, input.workEmail, input.firmName, input.role ?? null, input.message, ipHash, meta.userAgent?.slice(0, 400) ?? null]
      );
      return row;
    });

    if (config.pilot.notifyEmail) {
      // Best effort: the request is stored even if the notification cannot be sent.
      await mailService
        .send({
          to: config.pilot.notifyEmail,
          subject: `New pilot request from ${input.firmName}`,
          text: `${input.name} <${input.workEmail}> at ${input.firmName}${input.role ? ` (${input.role})` : ''} asked about a pilot.\n\nRequest id: ${id}`,
        })
        .catch((err: unknown) => console.warn(`[pilot] notification failed for ${id}: ${(err as Error).message}`));
    }
    return { id };
  }
}

export const pilotRequestService = new PilotRequestService();
