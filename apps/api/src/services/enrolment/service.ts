import { uuidv7 } from "../../lib/uuid.js";
import { CODE_LENGTH, generateEnrolmentCode } from "./code.js";
import {
  encodeApiKey,
  generateApiSecret,
  hashApiSecret,
} from "./credentials.js";
import type { EnrolmentRepository } from "./repository.js";

export const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_INSERT_ATTEMPTS = 5;

export class EnrolmentError extends Error {
  constructor(
    readonly code: "outlet_not_found" | "code_not_found" | "code_expired" | "code_already_used",
    message: string,
  ) {
    super(message);
    this.name = "EnrolmentError";
  }
}

export interface IssueCodeInput {
  outletId: string;
  createdByUserId: string;
}

export interface IssueCodeResult {
  code: string;
  outletId: string;
  expiresAt: Date;
}

export interface EnrolDeviceInput {
  code: string;
  // Reserved for the `devices.fingerprint` column added in KASA-21; today
  // it is surfaced to the route layer for the structured `device.enrolled`
  // audit log line and is not persisted on the device row.
  deviceFingerprint: string;
}

export interface EnrolDeviceResult {
  deviceId: string;
  apiKey: string;
  apiSecret: string;
  outlet: { id: string; name: string };
  merchant: { id: string; name: string };
}

export interface EnrolmentServiceDeps {
  repository: EnrolmentRepository;
  codeTtlMs?: number;
  now?: () => Date;
  generateCode?: () => string;
  generateDeviceId?: () => string;
}

export class EnrolmentService {
  private readonly repository: EnrolmentRepository;
  private readonly codeTtlMs: number;
  private readonly now: () => Date;
  private readonly generateCode: () => string;
  private readonly generateDeviceId: () => string;

  constructor(deps: EnrolmentServiceDeps) {
    this.repository = deps.repository;
    this.codeTtlMs = deps.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.now = deps.now ?? (() => new Date());
    this.generateCode = deps.generateCode ?? generateEnrolmentCode;
    this.generateDeviceId = deps.generateDeviceId ?? uuidv7;
  }

  async issueCode(input: IssueCodeInput): Promise<IssueCodeResult> {
    const outlet = await this.repository.findOutlet(input.outletId);
    if (!outlet) {
      throw new EnrolmentError("outlet_not_found", `No outlet ${input.outletId}.`);
    }

    const expiresAt = new Date(this.now().getTime() + this.codeTtlMs);

    for (let attempt = 0; attempt < MAX_CODE_INSERT_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      const existing = await this.repository.findEnrolmentCode(code);
      if (existing) continue;
      const row = await this.repository.createEnrolmentCode({
        code,
        outletId: input.outletId,
        createdByUserId: input.createdByUserId,
        expiresAt,
      });
      return { code: row.code, outletId: row.outletId, expiresAt: row.expiresAt };
    }
    throw new Error(
      `Could not generate a unique ${CODE_LENGTH}-char enrolment code in ${MAX_CODE_INSERT_ATTEMPTS} attempts.`,
    );
  }

  async enrolDevice(input: EnrolDeviceInput): Promise<EnrolDeviceResult> {
    const codeRow = await this.repository.findEnrolmentCode(input.code);
    if (!codeRow) {
      throw new EnrolmentError("code_not_found", "Enrolment code is not recognised.");
    }
    if (codeRow.consumedAt !== null) {
      throw new EnrolmentError(
        "code_already_used",
        "Enrolment code has already been consumed.",
      );
    }
    if (codeRow.expiresAt.getTime() <= this.now().getTime()) {
      throw new EnrolmentError("code_expired", "Enrolment code has expired.");
    }

    const outlet = await this.repository.findOutlet(codeRow.outletId);
    if (!outlet) {
      // The enrolment code outlived its outlet (e.g. deleted between issue
      // and redemption). Surface the same 410 the client sees for stale codes.
      throw new EnrolmentError(
        "code_expired",
        "Enrolment code is bound to an outlet that no longer exists.",
      );
    }

    const deviceId = this.generateDeviceId();
    const apiSecret = generateApiSecret();
    const apiKeyHash = await hashApiSecret(apiSecret);

    await this.repository.createDevice({
      id: deviceId,
      outletId: codeRow.outletId,
      apiKeyHash,
      status: "active",
    });
    await this.repository.consumeEnrolmentCode({
      code: codeRow.code,
      consumedByDeviceId: deviceId,
      consumedAt: this.now(),
    });

    return {
      deviceId,
      apiKey: encodeApiKey(deviceId),
      apiSecret,
      outlet: outlet.outlet,
      merchant: outlet.merchant,
    };
  }
}
