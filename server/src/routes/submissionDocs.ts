import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { Permission, requirePermission } from '../middleware/authorize';
import { ADMIN_DOC_KINDS, adminDocDocx, adminDocList, AdminDocKind } from '../submission/AdminDocs';
import { buildSummaryTable, summaryTableXlsx } from '../submission/SummaryTables';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F3.6 summary tables and administrative documents of a project.
 *   GET /api/projects/:projectId/summary-tables          the summary of testing, drafted from the filed test reports, with mismatches
 *   GET /api/projects/:projectId/summary-tables/export   the same as an Excel workbook (.xlsx); X-Mismatch-Count header
 *   GET /api/projects/:projectId/admin-docs              the four administrative documents: open items and blank signature fields
 *   GET /api/projects/:projectId/admin-docs/:kind        one as Word (.docx); kind: summary_510k | cover_letter | fda_3601 | truthful_accurate
 * Generated on request from the project's data (no model call); reading needs projects:read.
 */
export const submissionDocsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
const guard = (permission: Permission) => [authenticate, requirePermission(permission)];

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      r.error.issues[0]?.message ?? 'Invalid request',
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
    );
  }
  return r.data;
}

const projectId = (req: Request): string => parse(z.string().uuid('projectId must be a valid id'), req.params.projectId);
const kind = z.enum(ADMIN_DOC_KINDS as [AdminDocKind, ...AdminDocKind[]], { error: `kind must be one of ${ADMIN_DOC_KINDS.join(', ')}` });

function sendFile(res: Response, fileName: string, contentType: string, bytes: Buffer, headers: Record<string, string> = {}): void {
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  for (const [k, v] of Object.entries(headers)) res.set(k, v);
  res.set('Access-Control-Expose-Headers', ['Content-Disposition', ...Object.keys(headers)].join(', '));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Length', String(bytes.length));
  res.status(200).end(bytes);
}

submissionDocsRouter.get(
  '/api/projects/:projectId/summary-tables',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const table = await buildSummaryTable(orgId, projectId(req));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { ...table, reportCount: table.rows.length } });
  }),
);

submissionDocsRouter.get(
  '/api/projects/:projectId/summary-tables/export',
  guard('projects:read'),
  audit('summary_table.exported', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const table = await buildSummaryTable(orgId, projectId(req));
    const out = await summaryTableXlsx(table);
    sendFile(res, out.fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', out.bytes, { 'X-Mismatch-Count': String(table.mismatchCount) });
  }),
);

submissionDocsRouter.get(
  '/api/projects/:projectId/admin-docs',
  guard('projects:read'),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: await adminDocList(orgId, projectId(req)) });
  }),
);

submissionDocsRouter.get(
  '/api/projects/:projectId/admin-docs/:kind',
  guard('projects:read'),
  audit('admin_doc.generated', { targetType: 'project', targetId: fromParam('projectId') }),
  handle(async (req, res) => {
    const { orgId } = requireAuth(req);
    const id = projectId(req);
    const k = parse(kind, req.params.kind);
    const out = await adminDocDocx(orgId, id, k);
    sendFile(res, out.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', out.bytes, {
      'X-Open-Items': String(out.doc.openItems.length),
    });
  }),
);
