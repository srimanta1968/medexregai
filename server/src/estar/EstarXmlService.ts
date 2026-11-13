import { DOMParser, Element, XMLSerializer } from '@xmldom/xmldom';
import { config } from '../config/env';
import { dataService } from '../services/DataService';
import { AppError, ErrorCodes } from '../utils/AppError';
import * as nivd71 from './mappings/nIVD-7.1';
import { ExportContext, FieldMap, RepeatMap, RoundTrip } from './mappings/nIVD-7.1';
import catalogNivd71 from './templates/nIVD-7.1.fields.json';
import { SKELETON_NIVD_7_1 } from './templates/nIVD-7.1.skeleton';

/**
 * F5.4 eSTAR XML data file (ADR-019): the project's known facts written into the blank eSTAR's own
 * data tree, for the consultant to load with Import Data in Adobe Acrobat Pro. Attachments are
 * never included (FDA). The mapping is versioned per template; a template without a catalog and
 * mapping is refused. Off unless ESTAR_XML_EXPORT=on, until the Acrobat import check passes.
 */

interface CatalogField {
  path: string;
  kind: string;
  caption: string;
  options?: { caption: string; value: string | null }[];
  items?: { display?: string[]; save?: string[]; values?: string[] };
}

interface Template {
  key: string;
  catalog: { dataVersion: string; sourcePdfSha256: string; fields: CatalogField[] };
  skeleton: string;
  mappingVersion: string;
  fields: FieldMap[];
  repeats: RepeatMap<unknown>[];
  fillByHand: { section: string; what: string; why: string }[];
}

const TEMPLATES: Record<string, Template> = {
  'nIVD-7.1': {
    key: 'nIVD-7.1',
    catalog: catalogNivd71 as Template['catalog'],
    skeleton: SKELETON_NIVD_7_1,
    mappingVersion: nivd71.MAPPING_VERSION,
    fields: nivd71.FIELDS,
    repeats: nivd71.REPEATS,
    fillByHand: nivd71.FILL_BY_HAND,
  },
};

export const SUPPORTED_TEMPLATES = Object.keys(TEMPLATES);

/** Allowed saved values of a catalog field, or null when free text. */
function allowed(f: CatalogField): string[] | null {
  if (f.kind === 'radio') return (f.options ?? []).map((o) => o.value ?? '');
  if (f.kind === 'choiceList' && f.items?.save?.length) return f.items.save;
  if (f.kind === 'choiceList' && f.items?.values?.length) return f.items.values;
  if (f.kind === 'checkButton') return f.items?.values ?? ['1', '0'];
  return null;
}

/** Fail at startup if a mapping names a path the template's catalog lacks. */
function checkMapping(t: Template): void {
  const paths = new Set(t.catalog.fields.map((f) => f.path));
  const missing = [
    ...t.fields.map((f) => f.path),
    ...t.repeats.flatMap((r) => r.fields.map((f) => `${r.group}/${f.field}`)),
  ].filter((p) => !paths.has(p));
  if (missing.length) throw new Error(`eSTAR mapping ${t.mappingVersion} names fields not in the ${t.key} catalog: ${missing.join(', ')}`);
}
Object.values(TEMPLATES).forEach(checkMapping);

export interface FilledField {
  path: string;
  field: string;
  value: string;
  source: string;
  roundTrip: RoundTrip;
}

export interface EstarXmlReport {
  templateKey: string;
  templateDataVersion: string;
  mappingVersion: string;
  /** Every mapped field is unverified until the Acrobat Pro import check passes (ADR-019). */
  importChecked: boolean;
  filled: FilledField[];
  fillByHand: { section: string; what: string; why: string }[];
  warnings: string[];
}

function childNamed(parent: Element, name: string): Element | null {
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).nodeName === name) return n as Element;
  }
  return null;
}

function nodeAt(root: Element, path: string): Element | null {
  let cur: Element | null = root;
  for (const part of path.split('/')) {
    cur = cur ? childNamed(cur, part) : null;
  }
  return cur;
}

function setText(el: Element, value: string): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument!.createTextNode(value));
}

async function loadContext(orgId: string, projectId: string, userId: string): Promise<{ ctx: ExportContext; template: string }> {
  const [p] = await dataService.query<{
    submission_type: ExportContext['submissionType'];
    estar_template: string;
    client_name: string;
    device_name: string;
    model_names: string[];
    firm_name: string;
  }>(
    { orgId },
    'projects',
    `SELECT p.submission_type, p.estar_template, w.name AS client_name, d.name AS device_name, d.model_names, o.name AS firm_name
       FROM projects p
       JOIN client_workspaces w ON w.id = p.workspace_id AND w.org_id = p.org_id
       JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
       JOIN orgs o ON o.id = p.org_id
      WHERE p.id = $1 AND p.org_id = current_setting('app.org_id')::uuid`,
    [projectId],
  );
  if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  const [me] = await dataService.query<{ full_name: string; email: string }>({}, 'user_profiles', 'SELECT full_name, email FROM user_profiles WHERE user_id = $1', [userId]);
  const predicates = await dataService.query<{ predicate_k_number: string; predicate_device_name: string | null }>(
    { orgId },
    'se_comparisons',
    `SELECT predicate_k_number, predicate_device_name FROM se_comparisons
      WHERE project_id = $1 AND org_id = current_setting('app.org_id')::uuid ORDER BY created_at, id`,
    [projectId],
  );
  return {
    template: p.estar_template,
    ctx: {
      submissionType: p.submission_type,
      clientName: p.client_name,
      deviceName: p.device_name,
      modelNames: p.model_names ?? [],
      consultant: { fullName: me?.full_name ?? '', email: me?.email ?? '' },
      firmName: p.firm_name,
      predicates: predicates.map((r) => ({ kNumber: r.predicate_k_number, deviceName: r.predicate_device_name })),
    },
  };
}

export const estarXmlService = {
  /** Build the XML data file and a report of what was filled and what to fill by hand. */
  async build(orgId: string, projectId: string, userId: string): Promise<{ xml: string; fileName: string; report: EstarXmlReport }> {
    if (!config.estarXml.enabled) {
      throw new AppError(403, ErrorCodes.ESTAR_XML_DISABLED, 'eSTAR XML export is turned off until the Acrobat Pro import check passes (ADR-019).');
    }
    const { ctx, template } = await loadContext(orgId, projectId, userId);
    const t = TEMPLATES[template];
    if (!t) {
      throw new AppError(409, ErrorCodes.TEMPLATE_NOT_SUPPORTED, `eSTAR XML export supports ${SUPPORTED_TEMPLATES.join(', ')}; this project uses ${template}.`);
    }
    const catalog = new Map(t.catalog.fields.map((f) => [f.path, f]));
    const doc = new DOMParser().parseFromString(t.skeleton, 'text/xml');
    const root = doc.documentElement as unknown as Element;
    const filled: FilledField[] = [];
    const warnings: string[] = [];

    const put = (el: Element, path: string, value: string | null, source: string, roundTrip: RoundTrip) => {
      if (value === null || value === '') return;
      const f = catalog.get(path);
      const ok = f ? allowed(f) : null;
      if (ok && !ok.includes(value)) throw new Error(`eSTAR mapping ${t.mappingVersion}: ${value} is not an allowed value of ${path}`);
      setText(el, value);
      filled.push({ path, field: f?.caption || path, value, source, roundTrip });
    };

    for (const m of t.fields) {
      const el = nodeAt(root, m.path);
      if (!el) throw new Error(`eSTAR skeleton ${t.key} has no node ${m.path}`);
      put(el, m.path, m.value(ctx), m.source, m.roundTrip);
    }

    for (const r of t.repeats) {
      const first = nodeAt(root, r.group);
      if (!first) throw new Error(`eSTAR skeleton ${t.key} has no node ${r.group}`);
      const items = r.items(ctx);
      if (!items.length) continue;
      const template = first.cloneNode(true) as Element;
      let prev = first;
      items.forEach((item, i) => {
        const el = i === 0 ? first : (template.cloneNode(true) as Element);
        if (i > 0) {
          prev.parentNode!.insertBefore(el, prev.nextSibling);
          prev = el;
        }
        for (const f of r.fields) {
          const node = childNamed(el, f.field);
          if (!node) throw new Error(`eSTAR skeleton ${t.key} has no node ${r.group}/${f.field}`);
          put(node, `${r.group}/${f.field}`, f.value(item, ctx), `${r.source}${items.length > 1 ? ` (${i + 1} of ${items.length})` : ''}`, r.roundTrip);
        }
      });
    }

    if (!ctx.predicates.length) warnings.push('No SE comparison in this project yet, so no predicate is filled.');
    if (!ctx.modelNames.length) warnings.push('The device has no model names; the Model field is left empty.');
    if (ctx.consultant.fullName.trim().split(/\s+/).length < 2) warnings.push('Your profile name has one word, so first and last name may need fixing in the eSTAR.');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}\n`;
    const safe = ctx.deviceName.replace(/[^A-Za-z0-9 ()&,.-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      xml,
      fileName: `eSTAR data ${t.key} ${safe}.xml`,
      report: {
        templateKey: t.key,
        templateDataVersion: t.catalog.dataVersion,
        mappingVersion: t.mappingVersion,
        importChecked: [...t.fields.map((f) => f.roundTrip), ...t.repeats.map((r) => r.roundTrip)].every((r) => r === 'verified'),
        filled,
        fillByHand: t.fillByHand,
        warnings,
      },
    };
  },
};
