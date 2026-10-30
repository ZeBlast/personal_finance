/** Shared by the parts of the Categories and rules page: its notice, and its form styles. */

export type Notice = { kind: "info" | "error"; text: string };

export const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800";

export const buttonClass =
  "rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:bg-slate-700";

export const primaryClass =
  "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60";
