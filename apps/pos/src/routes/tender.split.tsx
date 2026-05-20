import { TenderSplitPanel } from "../features/tender-split/TenderSplitPanel";

export function TenderSplitScreen() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <TenderSplitPanel />
    </div>
  );
}
