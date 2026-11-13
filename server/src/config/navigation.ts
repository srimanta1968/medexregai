import type { Permission } from '../middleware/authorize';

/**
 * The app's menu, phase by phase, from UI 2.0 §3 ("Menu item" table). An item is
 * visible when its phase is <= APP_PHASE, unless FEATURE_FLAGS_OFF hides it or
 * FEATURE_FLAGS_ON turns it on early. `scope: project` items live under an open
 * project; `firm` items are always in the left nav.
 */
export type NavScope = 'firm' | 'project';

export interface NavItemDef {
  key: string;
  label: string;
  description: string;
  phase: 1 | 2 | 3 | 4 | 5;
  scope: NavScope;
  /** Role permission needed to see the item (omitted = every member). */
  permission?: Permission;
  /** True once the screen exists; enabled-but-unbuilt items show a "coming" page. */
  built: boolean;
}

export const NAV_CATALOG: readonly NavItemDef[] = [
  { key: 'clients', label: 'Clients and projects', description: 'One workspace per client, strictly separated', phase: 1, scope: 'firm', built: true },
  { key: 'connect', label: 'Connect', description: 'Link a folder; get the upload link and forwarding address', phase: 1, scope: 'project', built: true },
  { key: 'files', label: 'Files', description: 'Sorted folder by eSTAR section, versions, unreadable files', phase: 1, scope: 'project', built: true },
  { key: 'problems', label: 'Problems', description: 'Missing items and contradictions', phase: 1, scope: 'project', built: true },
  { key: 'requests', label: 'Client requests', description: 'Drafted requests; status until received', phase: 1, scope: 'project', built: true },
  { key: 'trust-pack', label: 'Trust pack', description: 'Validation and data-handling packs, scopes, deletion', phase: 1, scope: 'firm', built: true },
  { key: 'review', label: 'Review', description: 'Section board, Word export and re-import, open items', phase: 2, scope: 'project', built: true },
  { key: 'templates', label: 'Templates and past wording', description: "Your firm's section templates and past wording for drafting", phase: 2, scope: 'firm', built: true },
  { key: 'changes', label: 'Changes', description: 'What a new client revision affects', phase: 2, scope: 'project', built: true },
  {
    key: 'readiness',
    label: 'Readiness and records',
    description: 'Attachment checks, admin documents, eQMS record',
    phase: 2,
    scope: 'project',
    built: true,
  },
  // FR-14.20 time capture was moved earlier in PRD v2.0 ("P3-01, moved earlier"): visible from phase 1.
  // F4.2: the pilot report reads FR-14.20 time against the firm's baseline, so it shows wherever Time does.
  { key: 'pilot-report', label: 'Pilot report', description: 'Hours against the firm baseline; drafts kept without change; RA lead sign-off', phase: 1, scope: 'project', built: true },
  { key: 'time', label: 'Time', description: 'One-click time log by activity; weekly summary and CSV', phase: 1, scope: 'firm', built: true },
  { key: 'usage', label: 'Usage', description: 'Per-client usage export for rebilling', phase: 3, scope: 'firm', permission: 'billing:manage', built: true },
  {
    key: 'fda-letters',
    label: 'FDA letters',
    description: 'Additional Information letters split into tracked deficiencies',
    phase: 4,
    scope: 'project',
    built: true,
  },
  {
    key: 'predicates',
    label: 'Predicates and research',
    description: 'Predicate search, SE comparison, research library',
    phase: 4,
    scope: 'project',
    built: true,
  },
  { key: 'portfolio', label: 'Portfolio', description: 'All clients and projects at a glance', phase: 4, scope: 'firm', built: true },
  { key: 'introductions', label: 'Introductions', description: 'Opt-in client introductions for consultants', phase: 5, scope: 'firm', built: false },
  {
    key: 'billing',
    label: 'Billing and API',
    description: 'Self-serve plans, credits, API access',
    phase: 5,
    scope: 'firm',
    permission: 'billing:manage',
    built: false,
  },
  // Firm settings (E10) are not phase-gated: they exist from day one.
  {
    key: 'users',
    label: 'Users and roles',
    description: 'Invite people and set what they can do',
    phase: 1,
    scope: 'firm',
    permission: 'members:invite',
    built: true,
  },
  {
    key: 'ai-settings',
    label: 'AI models and cost',
    description: 'Which model answers each AI step, your own model, AI cost per project',
    phase: 1,
    scope: 'firm',
    permission: 'firm:manage',
    built: true,
  },
];

export interface FeatureFlags {
  phase: number;
  on: string[];
  off: string[];
}

/** Items enabled by the flags, before role filtering. */
export function enabledNavItems(flags: FeatureFlags): NavItemDef[] {
  return NAV_CATALOG.filter((item) => !flags.off.includes(item.key) && (item.phase <= flags.phase || flags.on.includes(item.key)));
}

export const NAV_KEYS: readonly string[] = NAV_CATALOG.map((i) => i.key);
