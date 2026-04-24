import { create } from "zustand";

export type PaperWidth = "58mm" | "80mm";

const STORAGE_KEY = "kassa.receipt.paper-width";
const DEFAULT: PaperWidth = "58mm";

function readInitial(): PaperWidth {
  if (typeof localStorage === "undefined") return DEFAULT;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "58mm" || raw === "80mm" ? raw : DEFAULT;
}

function persist(value: PaperWidth): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, value);
}

interface PaperWidthStore {
  width: PaperWidth;
  setWidth(value: PaperWidth): void;
}

export const usePaperWidthStore = create<PaperWidthStore>((set) => ({
  width: readInitial(),
  setWidth(value: PaperWidth) {
    persist(value);
    set({ width: value });
  },
}));

export const PAPER_WIDTH_CHAR_COLUMNS: Record<PaperWidth, 32 | 42> = {
  "58mm": 32,
  "80mm": 42,
};

export const PAPER_WIDTH_PX: Record<PaperWidth, number> = {
  "58mm": 280,
  "80mm": 380,
};
