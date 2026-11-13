import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { audit, fromParam } from '../middleware/audit';
import { authenticate, requireAuth } from '../middleware/authenticate';
import { requirePermission } from '../middleware/authorize';
import { estarXmlService } from '../estar/EstarXmlService';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * F5.4 eSTAR XML data file (ADR-019). Read: projects:read. Off unless ESTAR_XML_EXPORT=true.
 *   GET /api/projects/:projectId/estar-xml?format=json   what would be filled, from where, and what to fill by hand
 *   GET /api/projects/:projectId/estar-xml?format=xml    the XML file for Import Data in Adobe Acrobat Pro (audited)
 */
export const estarXmlRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      r.error.issues[0]?.message ?? 'Invalid request',
      r.error.issues.map((i) => ({ field: i.path.join('.') || where, message: i.message })),
    );
  }
  return r.data;
}

const query = z
  .object({ format: z.enum(['json', 'xml'], { error: 'format must be json or xml' }).default('json') }, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? `Unknown query parameter: ${iss.keys.join(', ')}` : undefined),
  })
  .strict();

estarXmlRouter.get(
  '/api/projects/:projectId/estar-xml',
  authenticate,
  requirePermission('projects:read'),
  audit('estar_xml.exported', {
    targetType: 'project',
    targetId: fromParam('projectId'),
    projectId: fromParam('projectId'),
    // Only the download is an export; the JSON report is a preview.
    when: (req) => req.query.format === 'xml',
    metadata: () => ({ format: 'xml' }),
  }),
  handle(async (req, res) => {
    const { orgId, userId } = requireAuth(req);
    const projectId = parse(z.string().uuid('projectId must be a valid id'), req.params.projectId, 'projectId');
    const { format } = parse(query, req.query, 'query');
    const out = await estarXmlService.build(orgId, projectId, userId);
    res.set('Cache-Control', 'no-store');
    if (format === 'xml') {
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${out.fileName}"`);
      res.set('Access-Control-Expose-Headers', 'Content-Disposition');
      res.status(200).send(out.xml);
      return;
    }
    res.status(200).json({ success: true, data: { fileName: out.fileName, ...out.report } });
  }),
);
