import { BadgePercent } from "lucide-react";
import { formatDiscountPeriod } from "@food/utils/menuDiscount";

/** Shown on the restaurant page while a menu discount is active for this restaurant. */
export default function MenuDiscountBanner({ menuDiscount }) {
  if (!menuDiscount?.percentage) return null;
  const period = formatDiscountPeriod(menuDiscount);

  return (
    <section className="px-4 sm:px-6 mt-4">
      <div className="max-w-7xl mx-auto">
        <div className="rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-lime-50 dark:from-emerald-950/30 dark:to-lime-950/20 dark:border-emerald-900/40 p-4 flex items-center gap-4">
          <div className="h-11 w-11 rounded-2xl bg-white dark:bg-[#1a1a1a] flex items-center justify-center shadow-sm shrink-0">
            <BadgePercent className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Restaurant offer</p>
            <p className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">
              {menuDiscount.percentage}% OFF on all items
            </p>
            {period && <p className="text-xs text-gray-500 mt-0.5">Valid {period} · applied automatically at checkout</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
