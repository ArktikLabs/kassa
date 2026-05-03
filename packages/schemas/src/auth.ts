import { z } from "zod";

const uuidV7 = z.string().uuid();

const enrolmentCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;

export const enrolmentCodeIssueRequest = z
  .object({
    outletId: uuidV7,
  })
  .strict();

export type EnrolmentCodeIssueRequest = z.infer<typeof enrolmentCodeIssueRequest>;

export const enrolmentCodeIssueResponse = z
  .object({
    code: z.string().regex(enrolmentCodePattern),
    outletId: uuidV7,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type EnrolmentCodeIssueResponse = z.infer<typeof enrolmentCodeIssueResponse>;

export const deviceEnrolRequest = z
  .object({
    code: z.string().regex(enrolmentCodePattern),
    deviceFingerprint: z.string().min(8).max(256),
  })
  .strict();

export type DeviceEnrolRequest = z.infer<typeof deviceEnrolRequest>;

const outletSummary = z
  .object({
    id: uuidV7,
    name: z.string().min(1),
  })
  .strict();

const merchantSummary = z
  .object({
    id: uuidV7,
    name: z.string().min(1),
  })
  .strict();

export const deviceEnrolResponse = z
  .object({
    deviceId: uuidV7,
    apiKey: z.string().min(1),
    apiSecret: z.string().min(1),
    outlet: outletSummary,
    merchant: merchantSummary,
  })
  .strict();

export type DeviceEnrolResponse = z.infer<typeof deviceEnrolResponse>;

export const STAFF_ROLES = ["owner", "manager", "cashier", "read_only"] as const;
export const staffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRole>;

export const sessionLoginRequest = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(256),
  })
  .strict();

export type SessionLoginRequest = z.infer<typeof sessionLoginRequest>;

/**
 * Staff session login response. The session itself is set as an
 * HTTP-only cookie by the server (ARCHITECTURE §4.1); the body returns
 * the staff identity the client needs to render the shell (display
 * name + role for the menu, email for the avatar, merchantId for
 * tenant-scoped reads, issuedAt for the inactivity-timer reset).
 */
export const sessionLoginResponse = z
  .object({
    email: z.string().email(),
    displayName: z.string().min(1),
    role: staffRole,
    merchantId: uuidV7,
    issuedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type SessionLoginResponse = z.infer<typeof sessionLoginResponse>;
