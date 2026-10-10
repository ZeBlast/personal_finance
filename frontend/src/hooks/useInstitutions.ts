import { useMemo } from "react";
import { useApi } from "./useApi";

export interface Institution {
  itemId: number;
  institutionName: string;
  /** A `data:` URL of the bank's logo, when Plaid has one. */
  logo: string | null;
  color: string | null;
}

/** The connected banks with their logos, by connection. */
export function useInstitutions(): Map<number, Institution> {
  const { data } = useApi<Institution[]>("/institutions");
  return useMemo(() => new Map((data ?? []).map((i) => [i.itemId, i])), [data]);
}
