import type { SyncTable } from "../db/types.ts";

/*
 * Error types the sync engine can raise. Only SyncParseError is fatal
 * (we crash the pull so the bug can't silently corrupt Dexie); the
 * others are recoverable and drive backoff.
 */

export class SyncParseError extends Error {
  readonly table: SyncTable;
  readonly issueSummary: string;
  readonly receivedKeys: readonly string[];
  constructor(
    table: SyncTable,
    message: string,
    options: {
      issueSummary: string;
      receivedKeys: readonly string[];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "SyncParseError";
    this.table = table;
    this.issueSummary = options.issueSummary;
    this.receivedKeys = options.receivedKeys;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly table: SyncTable;
  readonly retryable: boolean;
  constructor(table: SyncTable, status: number, message: string) {
    super(message);
    this.name = "SyncHttpError";
    this.table = table;
    this.status = status;
    this.retryable = status >= 500 && status < 600;
  }
}

export class SyncNetworkError extends Error {
  readonly table: SyncTable;
  constructor(table: SyncTable, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SyncNetworkError";
    this.table = table;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class SyncOfflineError extends Error {
  constructor() {
    super("Sync paused: device is offline");
    this.name = "SyncOfflineError";
  }
}
