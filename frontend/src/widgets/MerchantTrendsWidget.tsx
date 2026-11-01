import { MerchantTrends } from "../components/views/MerchantTrends";
import { defineWidget } from "./types";

export default defineWidget({
  id: "merchant-trends",
  title: "Merchant trends",
  description: "Who takes the most of your money, month by month, and who is growing.",
  group: "Spending",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 3 },
  order: 64,
  defaultConfig: { months: "6", count: 8, controls: false },
  configFields: [
    {
      key: "months",
      label: "Months to compare",
      type: "select",
      options: [
        { value: "3", label: "3 months" },
        { value: "6", label: "6 months" },
        { value: "12", label: "12 months" },
      ],
    },
    { key: "count", label: "Merchants to show", type: "number", min: 3, max: 15 },
    { key: "controls", label: "Show the category and sort controls", type: "boolean" },
  ],
  Component: function Trends({ config }) {
    return (
      <MerchantTrends
        months={Number(config.months)}
        limit={Number(config.count)}
        controls={Boolean(config.controls)}
      />
    );
  },
});
