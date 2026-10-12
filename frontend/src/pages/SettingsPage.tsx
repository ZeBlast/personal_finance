import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, browserTabUrl, errorMessage, insideTauri } from "../api/client";
import type { Health, PlaidEnvironment, PlaidStatus, Settings } from "../types/api";
import { Select } from "../components/common/Select";

const ENVIRONMENT_HELP: Record<PlaidEnvironment, string> = {
  fake: "Built-in sample banks. Nothing leaves your computer and no Plaid account is needed.",
  sandbox:
    "Plaid's test environment with fake banks. Needs your Plaid Sandbox client ID and secret.",
  production: "Your real banks. Needs your Plaid Production client ID and secret.",
};

const inputClass =
  "mt-1 block rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800";

/**
 * A whole-number setting. It saves when you press Enter or click away (not on every keystroke,
 * which would save "4" on the way to typing "45"), and explains an out-of-range entry in place.
 */
function NumberSetting({
  label,
  help,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [problem, setProblem] = useState<string | null>(null);

  // Follow the saved value if it changes from elsewhere.
  useEffect(() => setDraft(String(value)), [value]);

  async function commit(): Promise<void> {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setProblem(`Enter a whole number from ${min} to ${max}.`);
      return;
    }
    setProblem(null);
    if (parsed !== value) await onSave(parsed);
  }

  const id = useId();
  return (
    <div className="text-sm">
      {/* The label holds only the name; the help text is attached as a description. */}
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        aria-invalid={problem !== null}
        aria-describedby={`${id}-help`}
        onChange={(e) => {
          setDraft(e.target.value);
          setProblem(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={`${inputClass} w-32`}
      />
      {problem && (
        <span role="alert" className="block text-xs text-red-600">
          {problem}
        </span>
      )}
      <span id={`${id}-help`} className="block text-xs text-slate-500">
        {help}
      </span>
    </div>
  );
}

function CredentialsForm({
  environment,
  saved,
  onChanged,
  onError,
}: {
  environment: "sandbox" | "production";
  saved: boolean;
  onChanged: (status: PlaidStatus["credentialsSaved"]) => void;
  onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ credentialsSaved: PlaidStatus["credentialsSaved"] }>(
        "/plaid/credentials",
        { method: "PUT", body: JSON.stringify({ environment, clientId, secret }) },
      );
      // The secret is write-only: clear the fields so it is not left sitting in the page.
      setClientId("");
      setSecret("");
      onChanged(result.credentialsSaved);
    } catch (error) {
      onError(errorMessage(error, "Could not save the credentials."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ credentialsSaved: PlaidStatus["credentialsSaved"] }>(
        `/plaid/credentials/${environment}`,
        { method: "DELETE" },
      );
      onChanged(result.credentialsSaved);
    } catch (error) {
      onError(errorMessage(error, "Could not remove the credentials."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
    >
      <p className="text-sm">
        {saved ? (
          <span className="font-medium text-green-700 dark:text-green-400">
            Plaid {environment} credentials are saved.
          </span>
        ) : (
          <span className="font-medium text-amber-700 dark:text-amber-400">
            No Plaid {environment} credentials saved yet.
          </span>
        )}{" "}
        <span className="text-slate-500">
          They are stored encrypted on this computer and are never shown again.
        </span>
      </p>
      <label className="block text-sm">
        <span className="font-medium">Client ID</span>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} w-full`}
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">
          {environment === "sandbox" ? "Sandbox" : "Production"} secret
        </span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} w-full`}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || clientId.trim() === "" || secret.trim() === ""}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {saved ? "Replace credentials" : "Save credentials"}
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
          >
            Remove
          </button>
        )}
      </div>
    </form>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [plaid, setPlaid] = useState<PlaidStatus | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await api<Settings>("/settings"));
        setPlaid(await api<PlaidStatus>("/plaid/status"));
        setHealth(await api<Health>("/health"));
      } catch {
        setError("Could not load settings from the background service.");
      }
    })();
  }, []);

  async function save(patch: Partial<Settings>): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setSettings(
        await api<Settings>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
      );
      if (patch.plaidEnvironment) setPlaid(await api<PlaidStatus>("/plaid/status"));
    } catch (e) {
      setError(errorMessage(e, "Could not save that change."));
    } finally {
      setSaving(false);
    }
  }

  const tabUrl = browserTabUrl();

  return (
    <section className="max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {settings && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Syncing</h2>
          <NumberSetting
            label="Minutes between syncs at launch"
            help="When you open the app, it syncs a connection only if its last successful sync was longer ago than this. Reopening the app sooner skips the sync. Use 0 to sync every time. The Sync now button always syncs immediately."
            value={settings.syncCooldownMinutes}
            min={0}
            max={1440}
            disabled={saving}
            onSave={(minutes) => save({ syncCooldownMinutes: minutes })}
          />
          <NumberSetting
            label="Also sync while the app stays open, every (minutes)"
            help="0 means off: sync only at launch and with the Sync now button. A failed attempt is retried no more often than every 5 minutes. Changes apply right away."
            value={settings.autoSyncIntervalMinutes}
            min={0}
            max={1440}
            disabled={saving}
            onSave={(minutes) => save({ autoSyncIntervalMinutes: minutes })}
          />

          <label className="block text-sm">
            <span className="font-medium">Theme</span>
            <Select
              value={settings.theme}
              disabled={saving}
              onChange={(e) => void save({ theme: e.target.value as Settings["theme"] })}
              className={inputClass}
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </label>
        </div>
      )}

      {settings && plaid && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium">Bank connections (Plaid)</h2>

          <label className="block text-sm">
            <span className="font-medium">Data source</span>
            <Select
              value={settings.plaidEnvironment}
              disabled={saving}
              onChange={(e) => void save({ plaidEnvironment: e.target.value as PlaidEnvironment })}
              className={inputClass}
            >
              <option value="fake">Demo (built-in sample data)</option>
              <option value="sandbox">Plaid Sandbox (test banks)</option>
              <option value="production">Plaid Production (real banks)</option>
            </Select>
            <span className="text-xs text-slate-500">
              {ENVIRONMENT_HELP[settings.plaidEnvironment]}
            </span>
            <span className="mt-1 block text-xs text-slate-500">
              Each data source keeps its own connections. Switching hides the others but does not
              delete them.
            </span>
          </label>

          {settings.plaidEnvironment !== "fake" && (
            <CredentialsForm
              key={settings.plaidEnvironment}
              environment={settings.plaidEnvironment}
              saved={plaid.credentialsSaved[settings.plaidEnvironment]}
              onChanged={(credentialsSaved) => setPlaid({ ...plaid, credentialsSaved })}
              onError={setError}
            />
          )}

          <NumberSetting
            label="Days of history to request for new connections"
            help="Between 30 and 730. Plaid fixes this when a connection is created, so it cannot be increased later for existing connections."
            value={settings.plaidDaysRequested}
            min={30}
            max={730}
            disabled={saving}
            onSave={(days) => save({ plaidDaysRequested: days })}
          />
        </div>
      )}

      {insideTauri && tabUrl && (
        <div>
          <h2 className="text-lg font-medium">Use in a browser tab</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Opens this app in your default browser. It only works while this window stays open.
          </p>
          <button
            type="button"
            onClick={() => {
              openUrl(tabUrl).catch(() => setError("Could not open your default browser."));
            }}
            className="mt-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Open in browser
          </button>
        </div>
      )}

      {health && (
        <p className="text-xs text-slate-500">
          Version {health.version} · database {health.database ? "OK" : "unavailable"}
        </p>
      )}
    </section>
  );
}
