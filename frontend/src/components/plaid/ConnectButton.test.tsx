// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../../test/fakeBackend";
import { ConnectButton } from "./ConnectButton";

// Plaid's real window cannot open in a test: this stands in for it, and lets a test close it.
const plaid = vi.hoisted(() => ({
  config: null as null | {
    onExit: (error: unknown, metadata: { institution: { name: string } | null }) => void;
  },
}));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: (config: typeof plaid.config) => {
    plaid.config = config;
    return { open: () => undefined, ready: true };
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  plaid.config = null;
});

const item = { id: 7, institutionName: "First Platypus Bank" };

describe("connecting a bank", () => {
  it("connects through the demo picker, and passes plain success by", async () => {
    const calls = fakeBackend({
      "POST /plaid/link-token": { linkToken: "link-fake~new~1", environment: "fake" },
      "/plaid/fake/institutions": [
        { id: "ins_fake_bank", name: "First Platypus Bank", accountCount: 3 },
      ],
      "POST /plaid/exchange-token": { item },
    });
    const onDone = vi.fn();
    render(<ConnectButton label="Connect a bank" onDone={onDone} onError={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect a bank" }));
    await userEvent.click(await screen.findByRole("button", { name: /First Platypus Bank/ }));

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith("First Platypus Bank connected.", 7, false),
    );
    const exchange = calls.find((c) => c.path === "/plaid/exchange-token");
    expect(exchange?.body).toMatchObject({ institution: { id: "ins_fake_bank" } });
  });

  it("keeps a duplicate warning on screen and points to Add or remove accounts", async () => {
    fakeBackend({
      "POST /plaid/link-token": { linkToken: "link-fake~new~1", environment: "fake" },
      "/plaid/fake/institutions": [
        { id: "ins_fake_bank", name: "First Platypus Bank", accountCount: 3 },
      ],
      "POST /plaid/exchange-token": { item, duplicateOfItemId: 3 },
    });
    const onDone = vi.fn();
    render(<ConnectButton label="Connect a bank" onDone={onDone} onError={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect a bank" }));
    await userEvent.click(await screen.findByRole("button", { name: /First Platypus Bank/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [text, , needsAttention] = onDone.mock.calls[0]!;
    expect(needsAttention).toBe(true);
    expect(text).toContain("Add or remove accounts");
  });

  it("asks Plaid to let the user choose accounts on the same connection", async () => {
    const calls = fakeBackend({
      "POST /plaid/items/7/link-token": { linkToken: "link-sandbox-1", environment: "sandbox" },
    });
    render(
      <ConnectButton
        label="Add or remove accounts"
        reconnect={item}
        chooseAccounts
        onDone={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add or remove accounts" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ chooseAccounts: true });
  });

  it("says in plain words why Plaid's window closed, and nothing when the user just closed it", async () => {
    fakeBackend({
      "POST /plaid/link-token": { linkToken: "link-sandbox-1", environment: "sandbox" },
    });
    const onError = vi.fn();
    render(<ConnectButton label="Connect a bank" onDone={vi.fn()} onError={onError} />);

    await userEvent.click(screen.getByRole("button", { name: "Connect a bank" }));
    await waitFor(() => expect(plaid.config).not.toBeNull());
    plaid.config!.onExit({ error_code: "INSTITUTION_DOWN" }, { institution: { name: "Chase" } });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0]).toMatch(/^Chase is not responding/);
    // The button is ready again.
    expect(
      (screen.getByRole("button", { name: "Connect a bank" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Connect a bank" }));
    await waitFor(() => expect(plaid.config).not.toBeNull());
    plaid.config!.onExit(null, { institution: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
