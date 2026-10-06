import { useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";

interface Props {
  linkToken: string;
  onSuccess: (publicToken: string, institution: { id: string; name: string } | null) => void;
  onExit: () => void;
}

/** Opens Plaid's real Link window as soon as it is ready. Renders nothing itself. */
export function PlaidLauncher({ linkToken, onSuccess, onExit }: Props) {
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      // Link can in principle report success without a token; treat that as a cancelled attempt.
      if (!publicToken) {
        onExit();
        return;
      }
      onSuccess(
        publicToken,
        metadata.institution?.institution_id
          ? { id: metadata.institution.institution_id, name: metadata.institution.name }
          : null,
      );
    },
    onExit: () => onExit(),
  });

  useEffect(() => {
    if (ready) open();
  }, [ready, open]);

  return null;
}
