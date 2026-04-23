import type { Device, DeviceStatus } from "../../db/schema/devices.js";
import type { EnrolmentCode } from "../../db/schema/enrolment-codes.js";

export interface OutletWithMerchant {
  outlet: { id: string; name: string };
  merchant: { id: string; name: string };
}

export interface CreateEnrolmentCodeInput {
  code: string;
  outletId: string;
  createdByUserId: string;
  expiresAt: Date;
}

export interface CreateDeviceInput {
  id: string;
  outletId: string;
  apiKeyHash: string;
  status: DeviceStatus;
}

export interface ConsumeEnrolmentCodeInput {
  code: string;
  consumedByDeviceId: string;
  consumedAt: Date;
}

/**
 * The data plane behind the enrolment endpoints. The Postgres-backed Drizzle
 * implementation will land in KASA-21 / KASA-23; an in-memory implementation
 * lives in `./memory-repository.ts` and is the one wired into both `dev` and
 * `test` runs until then.
 */
export interface EnrolmentRepository {
  findOutlet(outletId: string): Promise<OutletWithMerchant | null>;
  createEnrolmentCode(input: CreateEnrolmentCodeInput): Promise<EnrolmentCode>;
  findEnrolmentCode(code: string): Promise<EnrolmentCode | null>;
  consumeEnrolmentCode(input: ConsumeEnrolmentCodeInput): Promise<void>;
  createDevice(input: CreateDeviceInput): Promise<Device>;
}
