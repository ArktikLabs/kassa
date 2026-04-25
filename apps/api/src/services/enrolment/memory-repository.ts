import type { DeviceAuthRecord, DeviceAuthRepository } from "../../auth/device-auth.js";
import type { Device } from "../../db/schema/devices.js";
import type { EnrolmentCode } from "../../db/schema/enrolment-codes.js";
import type {
  ConsumeEnrolmentCodeInput,
  CreateDeviceInput,
  CreateEnrolmentCodeInput,
  EnrolmentRepository,
  OutletWithMerchant,
} from "./repository.js";

export class InMemoryEnrolmentRepository implements EnrolmentRepository, DeviceAuthRepository {
  private readonly outlets = new Map<string, OutletWithMerchant>();
  private readonly codes = new Map<string, EnrolmentCode>();
  private readonly devices = new Map<string, Device>();

  seedOutlet(entry: OutletWithMerchant): void {
    this.outlets.set(entry.outlet.id, entry);
  }

  async findOutlet(outletId: string): Promise<OutletWithMerchant | null> {
    return this.outlets.get(outletId) ?? null;
  }

  async createEnrolmentCode(input: CreateEnrolmentCodeInput): Promise<EnrolmentCode> {
    if (this.codes.has(input.code)) {
      throw new Error(`enrolment code collision: ${input.code}`);
    }
    const row: EnrolmentCode = {
      code: input.code,
      merchantId: input.merchantId,
      outletId: input.outletId,
      createdByUserId: input.createdByUserId,
      expiresAt: input.expiresAt,
      consumedAt: null,
      consumedByDeviceId: null,
    };
    this.codes.set(input.code, row);
    return row;
  }

  async findEnrolmentCode(code: string): Promise<EnrolmentCode | null> {
    return this.codes.get(code) ?? null;
  }

  async consumeEnrolmentCode(input: ConsumeEnrolmentCodeInput): Promise<void> {
    const row = this.codes.get(input.code);
    if (!row) return;
    this.codes.set(input.code, {
      ...row,
      consumedAt: input.consumedAt,
      consumedByDeviceId: input.consumedByDeviceId,
    });
  }

  async createDevice(input: CreateDeviceInput): Promise<Device> {
    const now = new Date();
    const row: Device = {
      id: input.id,
      merchantId: input.merchantId,
      outletId: input.outletId,
      apiKeyHash: input.apiKeyHash,
      fingerprint: input.fingerprint,
      status: input.status,
      createdAt: now,
      lastSeenAt: null,
    };
    this.devices.set(input.id, row);
    return row;
  }

  async findDevice(deviceId: string): Promise<DeviceAuthRecord | null> {
    const row = this.devices.get(deviceId);
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      outletId: row.outletId,
      apiKeyHash: row.apiKeyHash,
      status: row.status,
    };
  }

  async touchDevice(deviceId: string, seenAt: Date): Promise<void> {
    const row = this.devices.get(deviceId);
    if (!row) return;
    this.devices.set(deviceId, { ...row, lastSeenAt: seenAt });
  }

  setDeviceStatus(deviceId: string, status: Device["status"]): void {
    const row = this.devices.get(deviceId);
    if (!row) return;
    this.devices.set(deviceId, { ...row, status });
  }

  // Test helpers — not part of the EnrolmentRepository contract.
  _peekDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }
}
