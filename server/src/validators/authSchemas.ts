import { z } from 'zod';

const email = z
  .string({ error: (iss) => (iss.input === undefined ? 'email is required' : undefined) })
  .trim()
  .toLowerCase()
  .max(254, 'email is too long')
  .email('email must be a valid email address');

/**
 * 12+ characters. bcrypt only reads the first 72 bytes, so longer passwords are
 * refused rather than silently truncated.
 */
const password = z
  .string({ error: (iss) => (iss.input === undefined ? 'password is required' : undefined) })
  .min(12, 'password must be at least 12 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be at most 72 bytes');

const opaqueToken = z.string().min(20, 'token is invalid').max(200, 'token is invalid');

export const registerSchema = z.object({
  fullName: z.string({ error: (iss) => (iss.input === undefined ? 'fullName is required' : undefined) }).trim().min(1, 'fullName is required').max(200),
  email,
  password,
  firmName: z.string({ error: (iss) => (iss.input === undefined ? 'firmName is required' : undefined) }).trim().min(1, 'firmName is required').max(200),
});

export const loginSchema = z.object({
  email,
  password: z.string({ error: (iss) => (iss.input === undefined ? 'password is required' : undefined) }).min(1, 'password is required').max(1024),
});

export const refreshSchema = z.object({ refreshToken: opaqueToken });

export const passwordResetRequestSchema = z.object({ email });

export const passwordResetConfirmSchema = z.object({ token: opaqueToken, newPassword: password });
