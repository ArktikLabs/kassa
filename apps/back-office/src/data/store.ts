/*
 * Local scaffold store.
 *
 * The back-office talks to `@kassa/api` over HTTP in production, but
 * the scaffold ticket only covers the UI surface — the delta-sync
 * endpoints (ARCHITECTURE.md §3.1 §2.2) land with the API feature
 * tickets. So we keep a small reactive store in localStorage with a
 * seed so every CRUD form renders a realistic table on first load.
 *
 * The store exposes a minimal subscribe/getSnapshot pair compatible
 * with `useSyncExternalStore`, and per-resource CRUD helpers. Keeping
 * it here (rather than a state library) keeps the scaffold bundle
 * small and the seams obvious when we swap it for TanStack Query +
 * real fetch calls.
 */

import type {
  Bom,
  CatalogItem,
  Device,
  EnrolmentCode,
  Outlet,
  ReconciliationRow,
  Staff,
} from "./types";

const STORE_KEY = "kassa.back-office.store.v1";

type State = {
  outlets: Outlet[];
  items: CatalogItem[];
  boms: Bom[];
  staff: Staff[];
  devices: Device[];
  enrolmentCodes: EnrolmentCode[];
  reconciliation: ReconciliationRow[];
};

function seed(): State {
  const outletId = "01H000000000000000000OUTLET1";
  const itemRice = "01H00000000000000000ITEM0001";
  const itemChickenPortion = "01H00000000000000000ITEM0002";
  const itemRiceComponent = "01H00000000000000000ITEM0003";
  const itemChickenComponent = "01H00000000000000000ITEM0004";
  const nasiAyamBom = "01H0000000000000000BOM00001";
  return {
    outlets: [
      {
        id: outletId,
        name: "Warung Pusat",
        taxProfile: "none",
        receiptHeader: "Warung Pusat · Jl. Sudirman No.1",
        addressLine: "Jl. Sudirman No.1, Jakarta",
      },
    ],
    items: [
      {
        id: itemRice,
        sku: "NSI-001",
        name: "Nasi Ayam",
        priceIdr: 25_000,
        uom: "porsi",
        imageUrl: null,
        isStockTracked: false,
        isActive: true,
      },
      {
        id: itemChickenPortion,
        sku: "AYM-001",
        name: "Ayam Goreng (extra)",
        priceIdr: 15_000,
        uom: "porsi",
        imageUrl: null,
        isStockTracked: true,
        isActive: true,
      },
      {
        id: itemRiceComponent,
        sku: "BRS-001",
        name: "Beras",
        priceIdr: 0,
        uom: "g",
        imageUrl: null,
        isStockTracked: true,
        isActive: true,
      },
      {
        id: itemChickenComponent,
        sku: "AYM-RAW",
        name: "Ayam mentah",
        priceIdr: 0,
        uom: "g",
        imageUrl: null,
        isStockTracked: true,
        isActive: true,
      },
    ],
    boms: [
      {
        id: nasiAyamBom,
        parentItemId: itemRice,
        components: [
          { componentItemId: itemRiceComponent, qty: 150, uom: "g" },
          { componentItemId: itemChickenComponent, qty: 120, uom: "g" },
        ],
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    ],
    staff: [
      {
        id: "01H0000000000000000STAFF001",
        displayName: "Siti Rahayu",
        email: "siti@warungpusat.id",
        role: "owner",
        pin: "1234",
        isActive: true,
      },
    ],
    devices: [],
    enrolmentCodes: [],
    reconciliation: [],
  };
}

function load(): State {
  if (typeof localStorage === "undefined") return seed();
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) {
    const s = seed();
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return s;
  }
  try {
    return JSON.parse(raw) as State;
  } catch {
    const s = seed();
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return s;
  }
}

function persist(state: State): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

let state: State = load();
const listeners = new Set<() => void>();

function emit(): void {
  persist(state);
  for (const l of listeners) l();
}

export function resetStore(next?: State): void {
  state = next ?? seed();
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): State {
  return state;
}

/* Stable id generator good enough for scaffold fixtures. When we wire
 * up the real API the server issues UUIDv7 on create. */
function mkId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

// Outlets ------------------------------------------------------------

export function createOutlet(input: Omit<Outlet, "id">): Outlet {
  const row: Outlet = { ...input, id: mkId("OUT") };
  state = { ...state, outlets: [...state.outlets, row] };
  emit();
  return row;
}

export function updateOutlet(id: string, patch: Partial<Omit<Outlet, "id">>): void {
  state = {
    ...state,
    outlets: state.outlets.map((o) => (o.id === id ? { ...o, ...patch } : o)),
  };
  emit();
}

// Catalog items ------------------------------------------------------

export function createItem(input: Omit<CatalogItem, "id">): CatalogItem {
  const row: CatalogItem = { ...input, id: mkId("ITM") };
  state = { ...state, items: [...state.items, row] };
  emit();
  return row;
}

export function updateItem(id: string, patch: Partial<Omit<CatalogItem, "id">>): void {
  state = {
    ...state,
    items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
  };
  emit();
}

export function setItemActive(id: string, isActive: boolean): void {
  updateItem(id, { isActive });
}

// BOMs ---------------------------------------------------------------

export function createBom(input: Omit<Bom, "id">): Bom {
  const row: Bom = { ...input, id: mkId("BOM") };
  state = { ...state, boms: [...state.boms, row] };
  emit();
  return row;
}

export function updateBom(id: string, patch: Partial<Omit<Bom, "id">>): void {
  state = {
    ...state,
    boms: state.boms.map((b) => (b.id === id ? { ...b, ...patch } : b)),
  };
  emit();
}

// Staff --------------------------------------------------------------

export function createStaff(input: Omit<Staff, "id">): Staff {
  const row: Staff = { ...input, id: mkId("STF") };
  state = { ...state, staff: [...state.staff, row] };
  emit();
  return row;
}

export function updateStaff(id: string, patch: Partial<Omit<Staff, "id">>): void {
  state = {
    ...state,
    staff: state.staff.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
  emit();
}

export function resetStaffPin(id: string, pin: string): void {
  updateStaff(id, { pin });
}

// Devices ------------------------------------------------------------

export function createEnrolmentCode(outletId: string): EnrolmentCode {
  // RFC 4648 base32 minus I/L/O/0/1 to match the server's `/v1/auth/
  // enrolment-codes` contract in @kassa/schemas (8 chars, A-HJ-NP-Z2-9).
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const row: EnrolmentCode = { code, outletId, expiresAt, status: "active" };
  state = { ...state, enrolmentCodes: [...state.enrolmentCodes, row] };
  emit();
  return row;
}

export function revokeDevice(id: string): void {
  state = {
    ...state,
    devices: state.devices.map((d) =>
      d.id === id ? { ...d, status: "revoked" } : d,
    ),
  };
  emit();
}
