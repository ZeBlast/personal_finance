import { useNavigate } from "react-router-dom";
import { CollectionShowcase } from "../components/accounts/cards/CollectionShowcase";
import { isCollection } from "../components/accounts/CollectionDialog";
import { useApi } from "../hooks/useApi";
import type { Account } from "../types/api";
import { WidgetState } from "./WidgetFrame";
import { defineWidget } from "./types";

/** A collection's showcase from the Accounts tab: its most valuable items, and "View all". */
export default defineWidget({
  id: "collection",
  title: "Collection",
  description:
    "A collection's showcase from the Accounts tab: its most valuable items (Pokémon cards with pictures) and a browser for all of them.",
  group: "Accounts",
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 4 },
  order: 470,
  defaultConfig: { accountId: "" },
  configFields: [
    {
      key: "accountId",
      label: "Collection",
      type: "account",
      allLabel: "The first collection",
      help: "Choose one of your collections (other accounts are ignored).",
    },
  ],
  Component: function Collection({ config }) {
    const navigate = useNavigate();
    const accounts = useApi<Account[]>("/accounts?includeHidden=1");
    const collections = (accounts.data ?? []).filter(isCollection);
    const chosen =
      collections.find((a) => String(a.id) === config.accountId) ?? collections[0] ?? null;
    return (
      <WidgetState
        loading={accounts.loading}
        error={accounts.error}
        empty={accounts.data !== null && !chosen}
        emptyText="No collections yet. Add one under Accounts."
      >
        {chosen && <CollectionShowcase account={chosen} onManage={() => navigate("/accounts")} />}
      </WidgetState>
    );
  },
});
