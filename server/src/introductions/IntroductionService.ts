import { config } from '../config/env';
import { fda } from '../fda/fdaService';
import { dataService } from '../services/DataService';
import { mailService } from '../services/MailService';
import { hashIp } from '../services/PilotRequestService';
import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, toPage } from '../utils/pagination';

/**
 * F6.2 opt-in introductions (UI 2.0 §8.2). A device company asks, with its consent, to be
 * introduced to a regulatory consultant. The request is offered ONLY to consultant firms that
 * opted in and whose FDA medical specialties and pathways match; among those, the firms offered
 * longest ago come first, up to FANOUT. A firm sees an anonymous brief; the company's name and
 * contact details appear only once the firm accepts, and the company is then told by email.
 */

export const FANOUT = 3;

/** FDA medical specialty (review panel) codes, as listed by FDA's eSTAR and classification data. */
export const SPECIALTIES: Record<string, string> = {
  AN: 'Anesthesiology',
  CV: 'Cardiovascular',
  CH: 'Clinical Chemistry',
  TX: 'Clinical Toxicology',
  DE: 'Dental',
  EN: 'Ear, Nose, & Throat',
  GU: 'Gastroenterology & Urology',
  SU: 'General & Plastic Surgery',
  HO: 'General Hospital & Personal Use',
  HE: 'Hematology',
  IM: 'Immunology',
  MI: 'Microbiology',
  NE: 'Neurology',
  OB: 'Obstetrics/Gynecology',
  OP: 'Ophthalmic',
  OR: 'Orthopedic',
  PA: 'Pathology',
  PM: 'Physical Medicine',
  RA: 'Radiology',
};
export type Pathway = '510k' | 'de_novo' | 'pma';
export const PATHWAY_LABEL: Record<Pathway | 'unsure', string> = { '510k': '510(k)', de_novo: 'De Novo', pma: 'PMA', unsure: 'Not sure yet' };

export interface IntroSettings {
  optedIn: boolean;
  specialties: string[];
  pathways: Pathway[];
  profile: string | null;
  updatedAt: string | null;
}

export interface RequestInput {
  companyName: string;
  contactName: string;
  contactEmail: string;
  brief: string;
  productCode?: string;
  specialty?: string;
  pathway: Pathway | 'unsure';
  consent: true;
}

export interface IntroductionView {
  id: string;
  status: 'offered' | 'accepted' | 'declined';
  offeredAt: string;
  decidedAt: string | null;
  brief: string;
  pathway: Pathway | 'unsure';
  pathwayLabel: string;
  specialty: string | null;
  specialtyLabel: string | null;
  productCode: string | null;
  /** Only once the firm has accepted. */
  company: { name: string; contactName: string; contactEmail: string } | null;
}

interface IntroRow {
  id: string;
  status: IntroductionView['status'];
  offered_at: Date;
  decided_at: Date | null;
  created_at: Date;
  brief: string;
  pathway: IntroductionView['pathway'];
  specialty: string | null;
  product_code: string | null;
  company_name: string;
  contact_name: string;
  contact_email: string;
}

const toView = (r: IntroRow): IntroductionView => ({
  id: r.id,
  status: r.status,
  offeredAt: r.offered_at.toISOString(),
  decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  brief: r.brief,
  pathway: r.pathway,
  pathwayLabel: PATHWAY_LABEL[r.pathway],
  specialty: r.specialty,
  specialtyLabel: r.specialty ? (SPECIALTIES[r.specialty] ?? null) : null,
  productCode: r.product_code,
  company: r.status === 'accepted' ? { name: r.company_name, contactName: r.contact_name, contactEmail: r.contact_email } : null,
});

const INTRO_SELECT = `SELECT i.id, i.status, i.offered_at, i.decided_at, i.offered_at AS created_at, q.brief, q.pathway, q.specialty, q.product_code,
                             q.company_name, q.contact_name, q.contact_email
                        FROM introductions i JOIN intro_requests q ON q.id = i.request_id`;

export const introductionService = {
  async getSettings(orgId: string): Promise<IntroSettings> {
    const [s] = await dataService.query<{ opted_in: boolean; specialties: string[]; pathways: Pathway[]; profile: string | null; updated_at: Date }>(
      {},
      'firm_intro_settings',
      'SELECT opted_in, specialties, pathways, profile, updated_at FROM firm_intro_settings WHERE org_id = $1',
      [orgId],
    );
    return s
      ? { optedIn: s.opted_in, specialties: s.specialties, pathways: s.pathways, profile: s.profile, updatedAt: s.updated_at.toISOString() }
      : { optedIn: false, specialties: [], pathways: [], profile: null, updatedAt: null };
  },

  async putSettings(orgId: string, userId: string, input: Omit<IntroSettings, 'updatedAt'>): Promise<IntroSettings> {
    await dataService.query(
      {},
      'firm_intro_settings',
      `INSERT INTO firm_intro_settings (org_id, opted_in, specialties, pathways, profile, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (org_id) DO UPDATE SET opted_in = EXCLUDED.opted_in, specialties = EXCLUDED.specialties, pathways = EXCLUDED.pathways,
             profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [orgId, input.optedIn, [...new Set(input.specialties)].sort(), [...new Set(input.pathways)].sort(), input.profile, userId],
    );
    return this.getSettings(orgId);
  },

  /** A company's request: stored with its consent time, then offered to matching opted-in firms. */
  async submitRequest(input: RequestInput, ip: string): Promise<{ id: string }> {
    const ipHash = hashIp(ip);
    const [recent] = await dataService.query<{ n: number }>(
      {},
      'intro_requests',
      `SELECT count(*)::int AS n FROM intro_requests WHERE source_ip_hash = $1 AND created_at > now() - interval '1 hour'`,
      [ipHash],
    );
    if ((recent?.n ?? 0) >= config.introductions.perIpPerHour) {
      throw new AppError(429, ErrorCodes.RATE_LIMITED, 'Too many requests. Please try again in an hour.');
    }
    // A product code fixes the specialty from FDA's classification; an unknown code is refused.
    let specialty = input.specialty ?? null;
    if (input.productCode) {
      const pc = await fda((c) => c.getProductCode(input.productCode as string));
      if (pc.medicalSpecialty && SPECIALTIES[pc.medicalSpecialty]) specialty = pc.medicalSpecialty;
    }

    const [req] = await dataService.query<{ id: string }>(
      {},
      'intro_requests',
      `INSERT INTO intro_requests (company_name, contact_name, contact_email, brief, product_code, specialty, pathway, consent_at, source_ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING id`,
      [input.companyName, input.contactName, input.contactEmail.toLowerCase(), input.brief, input.productCode ?? null, specialty, input.pathway, ipHash],
    );

    // Only firms that opted in; a firm with no specialties or pathways listed takes any.
    const firms = await dataService.query<{ org_id: string }>(
      {},
      'firm_intro_settings',
      `SELECT org_id FROM firm_intro_settings
        WHERE opted_in
          AND (cardinality(specialties) = 0 OR $1::text IS NULL OR $1::text = ANY(specialties))
          AND ($2::text = 'unsure' OR cardinality(pathways) = 0 OR $2::text = ANY(pathways))
        ORDER BY last_offered_at NULLS FIRST, updated_at, org_id
        LIMIT $3`,
      [specialty, input.pathway, FANOUT],
    );
    for (const f of firms) {
      await dataService.query({ orgId: f.org_id }, 'introductions', 'INSERT INTO introductions (org_id, request_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        f.org_id,
        req.id,
      ]);
    }
    if (firms.length) {
      await dataService.query({}, 'firm_intro_settings', 'UPDATE firm_intro_settings SET last_offered_at = now() WHERE org_id = ANY($1::uuid[])', [
        firms.map((f) => f.org_id),
      ]);
      await dataService.query({}, 'intro_requests', 'UPDATE intro_requests SET offered_count = $2 WHERE id = $1', [req.id, firms.length]);
    }
    return { id: req.id };
  },

  async list(orgId: string, opts: { status?: IntroductionView['status']; limit: number; cursor?: string }): Promise<Page<IntroductionView>> {
    const c = decodeCursor(opts.cursor);
    const rows = await dataService.query<IntroRow>(
      { orgId },
      'introductions',
      `${INTRO_SELECT}
        WHERE i.org_id = current_setting('app.org_id')::uuid AND ($1::text IS NULL OR i.status = $1::text)
          AND ($2::timestamptz IS NULL OR (i.offered_at, i.id) < ($2::timestamptz, $3::uuid))
        ORDER BY i.offered_at DESC, i.id DESC LIMIT $4`,
      [opts.status ?? null, c.createdAt, c.id, opts.limit + 1],
    );
    return toPage(rows, opts.limit, toView);
  },

  async get(orgId: string, id: string): Promise<IntroductionView> {
    const [r] = await dataService.query<IntroRow>({ orgId }, 'introductions', `${INTRO_SELECT} WHERE i.id = $1 AND i.org_id = current_setting('app.org_id')::uuid`, [id]);
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Introduction not found');
    return toView(r);
  },

  /** Accept (reveals the company's contact details and emails the company) or decline. */
  async decide(orgId: string, userId: string, id: string, decision: 'accept' | 'decline'): Promise<IntroductionView> {
    const status = decision === 'accept' ? 'accepted' : 'declined';
    const updated = await dataService.query<{ id: string }>(
      { orgId, userId },
      'introductions',
      `UPDATE introductions SET status = $2, decided_at = now(), decided_by = $3
        WHERE id = $1 AND org_id = current_setting('app.org_id')::uuid AND status = 'offered' RETURNING id`,
      [id, status, userId],
    );
    if (!updated.length) {
      const current = await this.get(orgId, id); // 404 when not this firm's
      throw new AppError(409, ErrorCodes.INTRODUCTION_DECIDED, `This introduction was already ${current.status}.`);
    }
    const view = await this.get(orgId, id);
    if (status === 'accepted' && view.company) {
      const [firm] = await dataService.query<{ firm: string; full_name: string; email: string }>(
        { orgId },
        'introductions',
        `SELECT o.name AS firm, p.full_name, p.email FROM orgs o, user_profiles p WHERE o.id = $1 AND p.user_id = $2`,
        [orgId, userId],
      );
      if (firm) {
        await mailService.send({
          to: view.company.contactEmail,
          subject: `${firm.firm} accepted your introduction request`,
          text: [
            `Hello ${view.company.contactName},`,
            '',
            `${firm.firm} has accepted your request to be introduced to a regulatory consultant. You can reach ${firm.full_name} at ${firm.email}.`,
            '',
            'You asked MedexRegAI to share your request with consultant firms that chose to receive introductions. MedexRegAI is not a party to any engagement you agree.',
          ].join('\n'),
        });
      }
    }
    return view;
  },
};
