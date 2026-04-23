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
