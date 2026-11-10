import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { pilotRequestService } from '../services/PilotRequestService';
import { AppError, ErrorCodes } from '../utils/AppError';

const text = (field: string, min: number, max: number) =>
  z
    .string({ required_error: `${field} is required` })
    .trim()
    .min(min, min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`)
    .max(max, `${field} must be at most ${max} characters`);

export const pilotRequestSchema = z.object({
  name: text('name', 1, 200),
  workEmail: z
    .string({ required_error: 'workEmail is required' })
    .trim()
    .toLowerCase()
    .max(254, 'workEmail is too long')
    .email('workEmail must be a valid email address'),
  firmName: text('firmName', 1, 200),
  role: z.string().trim().max(120, 'role must be at most 120 characters').optional(),
  message: text('message', 10, 4000),
  // Honeypot: hidden from people, filled in by naive bots. Anything here is refused.
  website: z.string().optional(),
});

// Full path so the route matches its api_definition exactly.
export const pilotRequestsRouter = Router();

/** Public: the website's "Request a pilot" form. */
pilotRequestsRouter.post('/api/pilot-requests', (req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const { website, ...input } = pilotRequestSchema.parse(req.body);
    if (website && website.trim() !== '') {
      throw new AppError(400, ErrorCodes.REQUEST_REJECTED, 'This request could not be accepted.');
    }
    const created = await pilotRequestService.create(input, { ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') });
    res.status(201).json({ success: true, data: created });
  })().catch((err: unknown) => {
    if (err instanceof AppError && err.code === ErrorCodes.RATE_LIMITED) {
      res.set('Retry-After', '3600');
    }
    next(err);
  });
});
