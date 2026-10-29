import { CalendarView } from "../components/calendar/CalendarView";
import { accountField } from "./fields";
import { defineWidget } from "./types";

export default defineWidget({
  id: "calendar",
  title: "Transaction calendar",
  description:
    "A month calendar showing what happened each day and on which account. Click a day for its transactions.",
  group: "Activity",
  defaultSize: { w: 6, h: 9 },
  minSize: { w: 4, h: 6 },
  order: 90,
  defaultConfig: { accountId: "" },
  configFields: [accountField],
  Component: function Calendar({ config, size }) {
    return <CalendarView accountId={config.accountId} compact={size.w < 5} />;
  },
});
