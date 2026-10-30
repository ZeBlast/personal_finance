import { useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";
import type { LinkExitError } from "../../lib/plaidLinkExit";

interface Props {
  linkToken: string;
  onSuccess: (publicToken: string, institution: { id: string; name: string } | null) => void;
  /** Called when Link closes without connecting: `error` is set when something went wrong. */
  onExit: (error: LinkExitError | null, institutionName: string | undefined) => void;
}

/** Opens Plaid's real Link window as soon as it is ready. Renders nothing itself. */
export function PlaidLauncher({ linkToken, onSuccess, onExit }: Props) {
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      // Link can in principle report success without a token; treat that as a cancelled attempt.
      if (!publicToken) {
        onExit(null, undefined);
        return;
      }
      onSuccess(
        publicToken,
        metadata.institution?.institution_id
          ? { id: metadata.institution.institution_id, name: metadata.institution.name }
          : null,
      );
    },
    onExit: (error, metadata) => onExit(error, metadata.institution?.name ?? undefined),
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return null;
}
