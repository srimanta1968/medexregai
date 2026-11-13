import Stripe from 'stripe';
import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F6.3 self-serve billing through Stripe. Prices are defined in Stripe, not here: the catalog is
 * every active Stripe price tagged metadata app=medexregai with kind=plan (recurring; metadata plan)
 * or kind=credits (one-time; metadata credits = how many). A firm pays on Stripe Checkout (card data
 * never reaches MedexRegAI); Stripe's signed webhook then sets the plan or adds the credits, once per
 * event and once per payment.
 */

export interface CatalogItem {
  priceId: string;
  kind: 'plan' | 'credits';
  plan: string | null;
  credits: number | null;
  name: string;
  amount: number | null;
  currency: string;
  interval: string | null;
}

export interface BillingView {
  plan: { key: string; priceId: string; status: string | null; currentPeriodEnd: string | null } | null;
  creditBalance: number;
  ledger: { id: string; delta: number; reason: string; note: string | null; createdAt: string }[];
  catalog: CatalogItem[];
  testMode: boolean;
}

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!config.stripe.secretKey) {
    throw new AppError(503, ErrorCodes.BILLING_UNAVAILABLE, 'Billing is not set up on this server (STRIPE_SECRET_KEY is empty).');
  }
  client ??= new Stripe(config.stripe.secretKey);
  return client;
}

let cached: { at: number; items: CatalogItem[] } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

async function catalog(): Promise<CatalogItem[]> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.items;
  const prices = await stripe().prices.list({ active: true, limit: 100, expand: ['data.product'] });
  const items: CatalogItem[] = [];
  for (const p of prices.data) {
    const m = p.metadata ?? {};
    if (m.app !== 'medexregai' || (m.kind !== 'plan' && m.kind !== 'credits')) continue;
    const credits = m.kind === 'credits' ? Number.parseInt(m.credits ?? '', 10) : null;
    if (m.kind === 'credits' && (!credits || credits <= 0)) continue; // misconfigured pack: never sell it
    if (m.kind === 'plan' && (!m.plan || !p.recurring)) continue;
    const product = typeof p.product === 'object' && p.product && !('deleted' in p.product && p.product.deleted) ? (p.product as Stripe.Product) : null;
    items.push({
      priceId: p.id,
      kind: m.kind,
      plan: m.kind === 'plan' ? m.plan : null,
      credits,
      name: product?.name ?? p.nickname ?? p.id,
      amount: p.unit_amount,
      currency: p.currency,
      interval: p.recurring?.interval ?? null,
    });
  }
  items.sort((a, b) => (a.kind === b.kind ? (a.amount ?? 0) - (b.amount ?? 0) : a.kind === 'plan' ? -1 : 1));
  cached = { at: Date.now(), items };
  return items;
}

async function ensureCustomer(orgId: string): Promise<string> {
  const [b] = await dataService.query<{ stripe_customer_id: string | null }>(
    { orgId },
    'firm_billing',
    "SELECT stripe_customer_id FROM firm_billing WHERE org_id = current_setting('app.org_id')::uuid",
    [],
  );
  if (b?.stripe_customer_id) return b.stripe_customer_id;
  const [org] = await dataService.query<{ name: string }>({}, 'orgs', 'SELECT name FROM orgs WHERE id = $1', [orgId]);
  const customer = await stripe().customers.create({ name: org?.name, metadata: { org_id: orgId, app: 'medexregai' } });
  await dataService.query(
    { orgId },
    'firm_billing',
    `INSERT INTO firm_billing (org_id, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = COALESCE(firm_billing.stripe_customer_id, EXCLUDED.stripe_customer_id), updated_at = now()`,
    [orgId, customer.id],
  );
  return customer.id;
}

/** Add credits for one Stripe payment, once (the ledger's stripe_ref is unique). */
async function creditPurchase(orgId: string, credits: number, ref: string, note: string): Promise<void> {
  await dataService.transaction({ orgId }, async (tx) => {
    const added = await tx.query<{ id: string }>(
      'credit_ledger',
      `INSERT INTO credit_ledger (org_id, delta, reason, stripe_ref, note) VALUES ($1, $2, 'purchase', $3, $4)
       ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING RETURNING id`,
      [orgId, credits, ref, note],
    );
    if (!added.length) return;
    await tx.query(
      'firm_billing',
      `INSERT INTO firm_billing (org_id, credit_balance) VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET credit_balance = firm_billing.credit_balance + EXCLUDED.credit_balance, updated_at = now()`,
      [orgId, credits],
    );
  });
}

async function setPlan(orgId: string, fields: { planKey?: string | null; priceId?: string | null; subscriptionId: string; status: string | null; periodEnd: Date | null }): Promise<void> {
  await dataService.query(
    { orgId },
    'firm_billing',
    `INSERT INTO firm_billing (org_id, plan_key, plan_price_id, subscription_id, subscription_status, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET plan_key = COALESCE(EXCLUDED.plan_key, firm_billing.plan_key),
           plan_price_id = COALESCE(EXCLUDED.plan_price_id, firm_billing.plan_price_id), subscription_id = EXCLUDED.subscription_id,
           subscription_status = EXCLUDED.subscription_status, current_period_end = COALESCE(EXCLUDED.current_period_end, firm_billing.current_period_end),
           updated_at = now()`,
    [orgId, fields.planKey ?? null, fields.priceId ?? null, fields.subscriptionId, fields.status, fields.periodEnd],
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const billingService = {
  catalog,

  async get(orgId: string): Promise<BillingView> {
    const [[b], ledger, items] = await Promise.all([
      dataService.query<{ plan_key: string | null; plan_price_id: string | null; subscription_status: string | null; current_period_end: Date | null; credit_balance: number }>(
        { orgId },
        'firm_billing',
        "SELECT plan_key, plan_price_id, subscription_status, current_period_end, credit_balance FROM firm_billing WHERE org_id = current_setting('app.org_id')::uuid",
        [],
      ),
      dataService.query<{ id: string; delta: number; reason: string; note: string | null; created_at: Date }>(
        { orgId },
        'credit_ledger',
        "SELECT id, delta, reason, note, created_at FROM credit_ledger WHERE org_id = current_setting('app.org_id')::uuid ORDER BY created_at DESC, id DESC LIMIT 20",
        [],
      ),
      catalog(),
    ]);
    return {
      plan:
        b?.plan_key && b.plan_price_id
          ? { key: b.plan_key, priceId: b.plan_price_id, status: b.subscription_status, currentPeriodEnd: b.current_period_end ? b.current_period_end.toISOString() : null }
          : null,
      creditBalance: b?.credit_balance ?? 0,
      ledger: ledger.map((l) => ({ id: l.id, delta: l.delta, reason: l.reason, note: l.note, createdAt: l.created_at.toISOString() })),
      catalog: items,
      testMode: config.stripe.secretKey.startsWith('sk_test_'),
    };
  },

  /** A Stripe Checkout page for one catalog price; the firm pays there and returns to /app/billing. */
  async checkout(orgId: string, priceId: string): Promise<{ url: string; sessionId: string }> {
    const item = (await catalog()).find((c) => c.priceId === priceId);
    if (!item) throw new AppError(404, ErrorCodes.NOT_FOUND, 'That plan or credit pack is not offered');
    const customer = await ensureCustomer(orgId);
    const metadata = { org_id: orgId, app: 'medexregai', kind: item.kind, price_id: item.priceId, plan: item.plan ?? '', credits: String(item.credits ?? '') };
    const session = await stripe().checkout.sessions.create({
      mode: item.kind === 'plan' ? 'subscription' : 'payment',
      customer,
      client_reference_id: orgId,
      line_items: [{ price: item.priceId, quantity: 1 }],
      success_url: `${config.appBaseUrl}/app/billing?checkout=success`,
      cancel_url: `${config.appBaseUrl}/app/billing?checkout=cancelled`,
      metadata,
      ...(item.kind === 'plan' ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
    });
    if (!session.url) throw new AppError(502, ErrorCodes.BILLING_UNAVAILABLE, 'Stripe did not return a checkout page');
    return { url: session.url, sessionId: session.id };
  },

  /** A Stripe webhook: verify the signature, handle each event once. Returns whether it was new. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: true; duplicate: boolean; handled: boolean }> {
    if (!config.stripe.webhookSecret) throw new AppError(503, ErrorCodes.BILLING_UNAVAILABLE, 'Billing webhooks are not set up (STRIPE_WEBHOOK_SECRET is empty).');
    if (!rawBody || !signature) throw new AppError(400, ErrorCodes.INVALID_SIGNATURE, 'Missing Stripe signature');
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    } catch {
      throw new AppError(400, ErrorCodes.INVALID_SIGNATURE, 'Stripe signature did not verify');
    }
    const fresh = await dataService.query<{ event_id: string }>(
      {},
      'stripe_events',
      'INSERT INTO stripe_events (event_id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
      [event.id, event.type],
    );
    if (!fresh.length) return { received: true, duplicate: true, handled: false };

    let handled = false;
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object as Stripe.Checkout.Session;
      const m = s.metadata ?? {};
      const orgId = m.org_id;
      if (m.app === 'medexregai' && orgId && UUID.test(orgId)) {
        if (s.mode === 'payment' && m.kind === 'credits' && s.payment_status === 'paid') {
          const credits = Number.parseInt(m.credits ?? '', 10);
          if (credits > 0) {
            await creditPurchase(orgId, credits, `checkout:${s.id}`, `${credits} credits bought`);
            handled = true;
          }
        } else if (s.mode === 'subscription' && m.kind === 'plan' && typeof s.subscription === 'string') {
          await setPlan(orgId, { planKey: m.plan || null, priceId: m.price_id || null, subscriptionId: s.subscription, status: 'active', periodEnd: null });
          handled = true;
        }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.org_id;
      if (sub.metadata?.app === 'medexregai' && orgId && UUID.test(orgId)) {
        const end = (sub as unknown as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } }).items?.data?.[0]?.current_period_end ??
          (sub as unknown as { current_period_end?: number }).current_period_end;
        await setPlan(orgId, {
          planKey: event.type === 'customer.subscription.deleted' ? null : (sub.metadata?.plan ?? null),
          subscriptionId: sub.id,
          status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
          periodEnd: end ? new Date(end * 1000) : null,
        });
        handled = true;
      }
    }
    return { received: true, duplicate: false, handled };
  },
};
