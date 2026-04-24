import { TenderQrisPanel } from "../features/tender-qris/TenderQrisPanel";

export function TenderQrisScreen() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <TenderQrisPanel />
    </div>
  );
}
