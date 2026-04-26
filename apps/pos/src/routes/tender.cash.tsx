import { TenderCashPanel } from "../features/tender-cash/TenderCashPanel";

export function TenderCashScreen() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <TenderCashPanel />
    </div>
  );
}
