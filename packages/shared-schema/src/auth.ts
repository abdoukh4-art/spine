import { z } from 'zod';
import { IdSchema, RoleSchema, TimestampSchema } from './common.js';

/** Public user representation. Never includes credentials. */
export const UserSchema = z.object({
  id: IdSchema,
  email: z.email(),
  displayName: z.string(),
  role: RoleSchema,
  disabled: z.boolean(),
  createdAt: TimestampSchema,
  lastLoginAt: TimestampSchema.nullable(),
});
export type User = z.infer<typeof UserSchema>;

/**
 * Password policy (OWASP ASVS V2.1): length over complexity rules.
 * 12–128 characters; no composition rules; breached-password check is a roadmap item.
 */
export const PasswordSchema = z.string().min(12).max(128);

export const LoginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  user: UserSchema,
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const CreateUserRequestSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().min(1).max(100),
  role: RoleSchema,
  password: PasswordSchema,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  occurredAt: TimestampSchema,
  actorId: IdSchema.nullable(),
  actorType: z.enum(['user', 'system', 'webhook', 'anonymous']),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcomeStatus: z.number().int().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = z.object({
  actorId: IdSchema.optional(),
  action: z.string().max(100).optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
