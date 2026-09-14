/**
 * The kit's form schemas (#1018).
 *
 * Plain Zod, fed to `@blokjs/validate` from the example workflows — which is
 * what keys the errors by dot path and hands them to `redirectBack()`. Exported
 * so an app can extend one (`RegisterSchema.extend({ company: z.string() })`)
 * instead of re-deriving the field names the pages already bind to.
 */

import { z } from "zod";

/** Minimum password length. Eight is NIST's floor; length beats composition rules. */
export const MIN_PASSWORD = 8;

const email = z.string().trim().min(1, "Email is required.").email("Enter a valid email address.");
const password = z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters.`);

export const LoginSchema = z.object({
	email,
	// Not `password` — a length rule on sign-in leaks the policy and makes an
	// old short password unusable without telling the user why.
	password: z.string().min(1, "Password is required."),
	remember: z.boolean().optional(),
});

export const RegisterSchema = z
	.object({
		name: z.string().trim().min(1, "Name is required."),
		email,
		password,
		passwordConfirmation: z.string(),
	})
	.refine((value) => value.password === value.passwordConfirmation, {
		message: "Passwords do not match.",
		path: ["passwordConfirmation"],
	});

export const ForgotPasswordSchema = z.object({ email });

export const ResetPasswordSchema = z
	.object({
		token: z.string().min(1, "This password reset link is invalid."),
		email,
		password,
		passwordConfirmation: z.string(),
	})
	.refine((value) => value.password === value.passwordConfirmation, {
		message: "Passwords do not match.",
		path: ["passwordConfirmation"],
	});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
