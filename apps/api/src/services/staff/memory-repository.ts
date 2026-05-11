import type { StaffAuthRecord, StaffRepository } from "./repository.js";

/**
 * In-memory staff store for tests and the bootstrap window before a
 * Postgres-backed repo lands. Lookups are case-insensitive on email to
 * mirror the `lower(email)` constraint we expect on the Pg side.
 */
export class InMemoryStaffRepository implements StaffRepository {
  private readonly byEmail = new Map<string, StaffAuthRecord>();
  private readonly byId = new Map<string, StaffAuthRecord>();

  seedStaff(record: StaffAuthRecord): void {
    this.byEmail.set(record.email.toLowerCase(), { ...record });
    this.byId.set(`${record.merchantId}::${record.id}`, { ...record });
  }

  async findByEmail(email: string): Promise<StaffAuthRecord | null> {
    const found = this.byEmail.get(email.toLowerCase());
    return found ? { ...found } : null;
  }

  async findById(input: { merchantId: string; staffId: string }): Promise<StaffAuthRecord | null> {
    const found = this.byId.get(`${input.merchantId}::${input.staffId}`);
    return found ? { ...found } : null;
  }
}
