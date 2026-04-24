import { CartPanel } from "../features/cart/ui/CartPanel";

export function CartScreen() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-white">
      <CartPanel />
    </div>
  );
}
