/** Small helpers shared by the Subscriptions page's parts. */
import { formatMinor } from "../../lib/money";

export const money = (n: number) => formatMinor(n, "USD");

export const todayDay = () => new Date().toISOString().slice(0, 10);
