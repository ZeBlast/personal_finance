import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface Props {
  children: ReactNode;
  /** The page's address: moving to another page clears the error, so the app stays usable. */
  resetKey: string;
}

interface State {
  error: Error | null;
  copied: boolean;
}

/**
 * Keeps one broken page from blanking the whole window: if a page's code throws while drawing,
 * only the page area shows what happened, the sidebar still works, and nothing is lost (an error
 * while drawing never changes saved data).
 */
export class PageErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A page failed to render:", error.message, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, copied: false });
    }
  }

  private async copyDetails(): Promise<void> {
    const { error } = this.state;
    if (!error) return;
    try {
      await navigator.clipboard.writeText(
        `${error.name}: ${error.message}\nPage: ${this.props.resetKey}\n${error.stack ?? ""}`,
      );
      this.setState({ copied: true });
    } catch {
      // No clipboard (a locked-down browser): the message on screen is still there to read.
    }
  }

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const button =
      "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800";
    return (
      <div role="alert" className="pf-fade-in max-w-xl space-y-3 py-6">
        <h1 className="text-xl font-semibold">This page ran into a problem</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Something in the app went wrong while showing it. Your data is safe: a problem showing a
          page never changes what is saved. The rest of the app still works from the sidebar.
        </p>
        <p className="rounded-md bg-slate-100 px-3 py-2 font-mono text-xs break-words text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {error.message || error.name}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null, copied: false })}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Try again
          </button>
          <Link to="/" className={button}>
            Go to the dashboard
          </Link>
          <button type="button" onClick={() => void this.copyDetails()} className={button}>
            {copied ? "Copied" : "Copy the details"}
          </button>
        </div>
      </div>
    );
  }
}
