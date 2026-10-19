import { z } from 'zod';
import { userRoleSchema } from '../enums.js';

// Normalize email to lowercase at the schema boundary. The DB uses citext so
// it is already case-insensitive, but normalizing here makes error messages
// and lookups deterministic regardless of what the client sent.
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .min(10, 'password must be at least 10 characters')
  .max(200);

// ---------------------------------------------------------------------------
// API input — what a caller may send to POST /auth/register.
// ---------------------------------------------------------------------------
// NOTE: `role` is exposed here for the demo so organizers and staff accounts
// can be created via curl. The buyer-facing UI does NOT expose role selection;
// it always sends `role: 'attendee'`. In a real system, self-registration
// would be attendee-only and organizer/staff accounts would be provisioned
// by an admin.
export const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(200),
  role: userRoleSchema.default('attendee'),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

// ---------------------------------------------------------------------------
// Sign-up form — what the buyer-facing UI validates before calling the API.
// ---------------------------------------------------------------------------
// Deliberately omits `role`: the client always sends `attendee`. Also adds
// `confirmPassword` and validates it matches — this is a client-only concern
// and never leaves the browser.
export const signupFormSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1, 'Tell us your name').max(200),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type SignupForm = z.infer<typeof signupFormSchema>;

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: userRoleSchema,
  displayName: z.string(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: authUserSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;