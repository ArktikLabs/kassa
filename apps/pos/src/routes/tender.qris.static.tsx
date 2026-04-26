import { TenderQrisStaticPanel } from "../features/tender-qris/TenderQrisStaticPanel";

export function TenderQrisStaticScreen() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <TenderQrisStaticPanel />
    </div>
  );
}
