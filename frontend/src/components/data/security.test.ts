import { describe, expect, it } from "vitest";
import { groupKey, normalizeRecoveryKey } from "./SecurityPanel";

describe("recovery key text", () => {
  const key = "0123456789abcdef".repeat(4);

  it("is shown in groups of eight and reads back the same", () => {
    const grouped = groupKey(key);
    expect(grouped.split(" ")).toHaveLength(8);
    expect(grouped.replace(/ /g, "")).toBe(key);
  });

  it("accepts a key typed with spaces or capitals", () => {
    expect(normalizeRecoveryKey(groupKey(key).toUpperCase())).toBe(key);
    expect(normalizeRecoveryKey(`  ${key}\n`)).toBe(key);
  });

  it("rejects anything that is not 64 hex characters", () => {
    expect(normalizeRecoveryKey("")).toBeNull();
    expect(normalizeRecoveryKey(key.slice(1))).toBeNull();
    expect(normalizeRecoveryKey(`${key}0`)).toBeNull();
    expect(normalizeRecoveryKey(`${key.slice(0, 63)}g`)).toBeNull();
  });
});
