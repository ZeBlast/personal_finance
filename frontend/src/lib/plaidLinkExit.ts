/** The part of Plaid Link's exit error this app reads (react-plaid-link's PlaidLinkError). */
export interface LinkExitError {
  error_code: string;
  error_message?: string | null;
  display_message?: string | null;
}

const BANK_UNAVAILABLE = new Set([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_NO_LONGER_SUPPORTED",
]);
const NO_ACCOUNTS = new Set([
  "NO_ACCOUNTS",
  "NO_AUTH_ACCOUNTS",
  "NO_INVESTMENT_ACCOUNTS",
  "NO_INVESTMENT_AUTH_ACCOUNTS",
  "NO_LIABILITY_ACCOUNTS",
  "INSTITUTION_NOT_SUPPORTED",
  "PRODUCTS_NOT_SUPPORTED",
]);

/**
 * Why Plaid's window closed, in plain words, or null when the user simply closed it. Nothing is
 * changed in the app when Link exits, so each message can say what to do next.
 */
export function linkExitMessage(error: LinkExitError | null, bank?: string): string | null {
  if (!error) return null;
  const name = bank ?? "The bank";
  const code = error.error_code;
  if (BANK_UNAVAILABLE.has(code)) {
    return `${name} is not responding to Plaid right now. Try again later; nothing was changed.`;
  }
  if (code === "INVALID_CREDENTIALS") {
    return "The bank did not accept that username or password. Check them on the bank's own website, then try again.";
  }
  if (code === "INVALID_MFA" || code === "INVALID_SEND_METHOD") {
    return "The verification code was not accepted. Try again and use the newest code the bank sends.";
  }
  if (code === "ITEM_LOCKED") {
    return "The bank locked sign-in after too many attempts. Unlock it on the bank's website, then try again.";
  }
  if (code === "USER_SETUP_REQUIRED") {
    return "The bank needs you to finish something on its website first, such as accepting new terms or changing a password. Do that, then try again.";
  }
  if (NO_ACCOUNTS.has(code)) {
    return "Plaid did not find any accounts it can connect there. Accounts it cannot reach can be kept by hand instead.";
  }
  if (code === "INVALID_LINK_TOKEN" || code === "TOO_MANY_VERIFICATION_ATTEMPTS") {
    return "The connection window timed out or was closed too many times. Start again.";
  }
  if (code === "RATE_LIMIT_EXCEEDED" || code.endsWith("_RATE_LIMIT")) {
    return "Plaid is busy with too many attempts. Wait a few minutes and try again.";
  }
  return (
    error.display_message ||
    (error.error_message
      ? `Plaid stopped: ${error.error_message}`
      : "Plaid closed before the connection finished.")
  );
}
