import type { Device, DeviceStatus } from "../../db/schema/devices.js";
import type { EnrolmentCode } from "../../db/schema/enrolment-codes.js";

export interface OutletWithMerchant {
  outlet: { id: string; name: string };
  merchant: { id: string; name: string };
}

export interface CreateEnrolmentCodeInput {
  code: string;
  merchantId: string;
  outletId: string;
  createdByUserId: string;
  expiresAt: Date;
}

export interface CreateDeviceInput {
  id: string;
  merchantId: string;
  outletId: string;
  apiKeyHash: string;
  fingerprint: string | null;
  status: DeviceStatus;
}

export interface ConsumeEnrolmentCodeInput {
  code: string;
  consumedByDeviceId: string;
  consumedAt: Date;
}

/**
 * The data plane behind the enrolment endpoints. KASA-21 shipped the Drizzle
 * table definitions plus the `merchantId` / `fingerprint` contract for
 * persistence; the Postgres-backed implementation of this interface lands in a
 * follow-up alongside the transactional `consume + create` method called out
 * in the KASA-53 hand-off note. `./memory-repository.ts` is the in-memory
 * implementation wired into `dev` and `test`.
 */
export interface EnrolmentRepository {
  findOutlet(outletId: string): Promise<OutletWithMerchant | null>;
  createEnrolmentCode(input: CreateEnrolmentCodeInput): Promise<EnrolmentCode>;
  findEnrolmentCode(code: string): Promise<EnrolmentCode | null>;
  consumeEnrolmentCode(input: ConsumeEnrolmentCodeInput): Promise<void>;
  createDevice(input: CreateDeviceInput): Promise<Device>;
}
