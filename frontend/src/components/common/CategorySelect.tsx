import { Select, type SelectProps } from "./Select";

/**
 * A category dropdown: the app's Select, whose list shows main categories with their
 * subcategories indented under them (options carry `data-depth`, see categoryOptions) and whose
 * closed box shows the chosen category's name.
 */
export function CategorySelect({
  shown: _shown,
  ...select
}: SelectProps & {
  /** Kept for callers; the box shows the chosen option's name by itself. */
  shown?: string;
}) {
  return <Select {...select} />;
}
