import type { QrisOrderStatus } from "./types.js";

export interface TenderPaidEvent {
  type: "tender.paid";
  provider: string;
  providerOrderId: string;
  grossAmount: number;
  paidAt: string;
}

export interface TenderStatusChangedEvent {
  type: "tender.status_changed";
  provider: string;
  providerOrderId: string;
  status: QrisOrderStatus;
  grossAmount: number;
  occurredAt: string;
}

export type PaymentDomainEvent = TenderPaidEvent | TenderStatusChangedEvent;
