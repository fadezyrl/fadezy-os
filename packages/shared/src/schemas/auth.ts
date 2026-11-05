import { z } from 'zod';

/** International email addresses (RFC-oriented, length-bounded). */
export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Email is required')
  .max(320, 'Email is too long')
  .email('Enter a valid email address');

/**
 * Password policy for registration and reset.
 * Unicode-safe length checks; requires mixed case and a digit.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/u, 'Password must include a lowercase letter')
  .regex(/[A-Z]/u, 'Password must include an uppercase letter')
  .regex(/[0-9]/u, 'Password must include a number');

/** Unicode-capable display names (no market-specific defaults). */
export const fullNameSchema = z
  .string()
  .trim()
  .min(1, 'Full name is required')
  .max(120, 'Full name is too long');

export const registerInputSchema = z
  .object({
    email: emailSchema,
    fullName: fullNameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});

export const forgotPasswordInputSchema = z.object({
  email: emailSchema,
});

export const resetPasswordInputSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const updateProfileInputSchema = z.object({
  fullName: fullNameSchema.nullable().optional(),
  avatarUrl: z
    .union([z.string().url().max(2048), z.literal(''), z.null()])
    .optional(),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
