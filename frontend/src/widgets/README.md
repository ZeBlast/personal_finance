# Adding a dashboard widget

A widget is **one file** in this folder. You do not edit any list, route, or server code.

## The short version

1. Copy `TemplateWidget.example.tsx` to `YourThingWidget.tsx` (the name must end in `Widget.tsx`).
2. Change the `id`, `title`, `description`, and the component's content.
3. Save. The widget now appears in **Dashboard → Edit dashboard → + Add widget**, with a settings dialog
   built from the settings you declared.

That is all. The registry finds the file automatically, and the automated tests check it against the
contract (`npm test`), so a mistake is reported with a plain message.

## What you declare

```ts
export default defineWidget({
  id: "my-widget", // permanent, lowercase letters, digits, dashes
  title: "My widget",
  description: "One sentence for the picker.",
  group: "Spending", // Accounts | Spending | Budgets | Activity | Tools
  defaultSize: { w: 6, h: 6 }, // columns (of 12) by rows
  minSize: { w: 3, h: 3 },
  defaultEnabled: false, // true = part of the first-run dashboard
  order: 100, // place in that first-run dashboard
  singleton: false, // true = only one allowed
  defaultConfig: { period: "this-month" }, // a value for every setting below
  configFields: [periodField], // the settings dialog is generated from these
  Component: function MyWidget({ config, size }) {
    /* ... */
  },
});
```

### Settings (`configFields`)

Each field has a `key`, a `label`, and a `type`:

| type       | stored as                    | extra options                 |
| ---------- | ---------------------------- | ----------------------------- |
| `select`   | string                       | `options: [{ value, label }]` |
| `number`   | number                       | `min`, `max`, `step`          |
| `boolean`  | true / false                 |                               |
| `text`     | string                       | `maxLength`                   |
| `account`  | account ID as text, or `""`  | (a picker of all accounts)    |
| `category` | category ID as text, or `""` | (a picker of all categories)  |

`fields.ts` has ready-made ones used by many widgets: `periodField`, `accountField`, `categoryField`,
`includeTransfersField`, `monthsField`, and `countField(key, label, min, max)`.

The `config` your component receives is **already checked**: unknown keys are dropped, values of the
wrong type or out of range are replaced by your defaults, and settings added in a later version are
filled in. You never need to defend against odd saved settings.

## Getting data

Most widgets need no new server code. The `useApi` hook loads any endpoint and reloads itself after a
sync finishes:

```ts
const { data, error, loading } = useApi<Summary>(summaryPath({ from, to, groupBy: "category" }));
```

`/analytics/summary` (see `lib/analytics.ts`) returns spending, income, and counts for any date range,
grouped by `day`, `week`, `month`, `category`, `merchant`, `account`, or `institution`, and can be
filtered by account or category. Other useful endpoints: `/analytics/overview` (balances and net worth),
`/analytics/calendar`, `/budgets`, `/transactions`, `/accounts`, `/sync/status`.

**What "spending" means** (the same everywhere): transfers and credit-card payments are left out,
refunds reduce spending, income is money in on income categories, and pending transactions are
included. See the comment at the top of `backend/src/services/analytics.service.ts`.

## Building blocks

- `WidgetState`: one component for the loading, error, and empty states, so all widgets look alike.
- `Stat`: a headline number with a caption.
- Charts in `components/charts`: `BarList`, `Donut`, `ColumnChart`, `ProgressBar`.
- `lib/period.ts`: `resolvePeriod("this-month")` gives dates plus the range to compare with.
- `lib/money.ts`: `formatMinor(cents, "USD")`. Money is always whole cents.

## When a widget does need a new endpoint

Add a route under `backend/src/routes` and a function under `backend/src/services` as usual. The
dashboard layout itself never needs changing: the server stores widget types and settings as plain
text, so it does not know or care which widgets exist.

## Things that are handled for you

- A widget that throws only breaks its own card.
- A saved dashboard that mentions a widget this version does not have keeps its place and settings,
  and shows a "not available" card instead of crashing.
- New dashboards are built from the widgets that set `defaultEnabled: true`.
- Existing dashboards are never changed by a new widget; it just appears in the picker.

## Rules that keep saved dashboards working

- **Never change a widget's `id`** once it may be on someone's dashboard.
- Renaming a setting's `key` resets that setting to its default for existing dashboards. Prefer
  adding a new setting.
- Settings values are plain strings, numbers, and booleans so they save as JSON.
