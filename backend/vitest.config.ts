import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test opens its own encrypted database; on a busy machine or a slower CI runner a few
    // take longer than vitest's default 5 seconds without anything being wrong.
    testTimeout: 30_000,
  },
});
