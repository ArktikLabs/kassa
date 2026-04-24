import { EventEmitter } from "node:events";
import type { PaymentDomainEvent } from "@kassa/payments";

export type DomainEvent = PaymentDomainEvent;

export interface DomainEventBus {
  emit(event: DomainEvent): void;
  on(type: DomainEvent["type"], listener: (event: DomainEvent) => void): void;
  off(type: DomainEvent["type"], listener: (event: DomainEvent) => void): void;
}

export function createDomainEventBus(): DomainEventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return {
    emit(event) {
      emitter.emit(event.type, event);
    },
    on(type, listener) {
      emitter.on(type, listener as (event: DomainEvent) => void);
    },
    off(type, listener) {
      emitter.off(type, listener as (event: DomainEvent) => void);
    },
  };
}
