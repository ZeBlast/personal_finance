import { useState } from "react";
import { HowThisWorks } from "../components/common/HowThisWorks";
import { RecurringSection } from "../components/insights/RecurringSection";
import { primaryClass } from "../components/investments/styles";
import { FoundSection } from "../components/subscriptions/FoundSection";
import { RenewalInbox } from "../components/subscriptions/RenewalInbox";
import { SubscriptionDialog } from "../components/subscriptions/SubscriptionDialog";
import {
  draftFromSeries,
  draftOf,
  emptyDraft,
  type Draft,
} from "../components/subscriptions/subscriptionDraft";
import { TrackedSection } from "../components/subscriptions/TrackedSection";
import { useApi } from "../hooks/useApi";
import { subscriptionsSentence } from "../lib/pageSummaries";
import { announceDataChanged } from "../lib/syncEvents";
import type { SubscriptionReview, TrackedSubscriptionList } from "../types/planning";

/**
 * Everything you pay for again and again: subscriptions you keep track of (added here, with the
 * details of the account such as the email used), and the recurring charges found in your history.
 */
export function SubscriptionsPage() {
  const tracked = useApi<TrackedSubscriptionList>("/tracked-subscriptions");
  const review = useApi<SubscriptionReview>("/subscriptions");
  const [editing, setEditing] = useState<Draft | null>(null);

  const reload = () => {
    tracked.reload();
    review.reload();
    announceDataChanged();
  };
  const trackedKeys = new Set(
    (tracked.data?.subscriptions ?? []).map((s) => s.recurringKey).filter(Boolean),
  );

  const sentence =
    tracked.data && review.data
      ? subscriptionsSentence({
          currency: review.data.currency,
          tracked: {
            count: tracked.data.totals.active,
            monthlyMinor: tracked.data.totals.monthlyMinor,
          },
          found: {
            // The same ones the Found table shows before you ask for the stopped ones.
            count: review.data.subscriptions.filter((x) => x.status === "active").length,
            monthlyMinor: review.data.totals.monthlyMinor,
          },
        })
      : null;

  return (
    <section className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Subscriptions</h1>
          {sentence && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{sentence}</p>
          )}
          <HowThisWorks>
            <p>
              What you pay for again and again, when each charges next or ends, and the details of
              each account. Upcoming charges of ones you add show on the calendar.
            </p>
          </HowThisWorks>
        </div>
        <button type="button" className={primaryClass} onClick={() => setEditing(emptyDraft())}>
          Add a subscription
        </button>
      </div>

      <RenewalInbox
        onOpen={(id) => {
          const s = tracked.data?.subscriptions.find((x) => x.id === id);
          if (s) setEditing(draftOf(s));
        }}
      />
      <TrackedSection state={tracked} onEdit={(s) => setEditing(draftOf(s))} onChanged={reload} />
      <FoundSection
        state={review}
        trackedKeys={trackedKeys}
        onTrack={(s) => setEditing(draftFromSeries(s))}
      />
      {/* Every regular charge and deposit found, bills and pay included (moved from Insights). */}
      <RecurringSection />

      {editing && (
        <SubscriptionDialog
          draft={editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      )}
    </section>
  );
}
