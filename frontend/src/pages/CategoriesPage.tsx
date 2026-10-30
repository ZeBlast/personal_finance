import { useState } from "react";
import { CategoriesSection } from "../components/categories/CategoriesSection";
import { MerchantsSection } from "../components/categories/MerchantsSection";
import { RulesSection } from "../components/categories/RulesSection";
import { useCategories } from "../hooks/useCategories";

/** One of the three columns: in three columns, it scrolls on its own so all three stay in view. */
const COLUMN =
  "min-w-0 @min-[96rem]:max-h-[calc(100vh-11rem)] @min-[96rem]:overflow-y-auto @min-[96rem]:pr-2";

export function CategoriesPage() {
  const { categories, reload } = useCategories(true);
  // Assigning a merchant adds or changes a rule, so the rules list is rebuilt when it happens.
  const [rulesVersion, setRulesVersion] = useState(0);
  return (
    <section className="@container space-y-6">
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold">Categories and rules</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Organize your spending. Rules categorize transactions automatically, and you can always
          override a single transaction by hand.
        </p>
      </div>
      {/* Categories, merchants and rules side by side when the page has room (each column then
          scrolls on its own), two and one below when it is narrower, one above another when
          narrow. Decided by the page's own width, not the window's. */}
      <div className="grid items-start gap-8 @min-[60rem]:grid-cols-2 @min-[96rem]:grid-cols-3">
        <div className={COLUMN}>
          <CategoriesSection onChanged={() => void reload()} />
        </div>
        <div className={COLUMN}>
          <MerchantsSection
            categories={(categories ?? []).filter((c) => c.active)}
            onChanged={() => setRulesVersion((v) => v + 1)}
          />
        </div>
        <div className={`${COLUMN} @min-[60rem]:col-span-2 @min-[96rem]:col-span-1`}>
          <RulesSection key={rulesVersion} categories={categories ?? []} />
        </div>
      </div>
    </section>
  );
}
