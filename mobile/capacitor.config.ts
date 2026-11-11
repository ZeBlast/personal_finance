import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.personalfinance.viewer",
  appName: "Finance Viewer",
  webDir: "dist",
  android: {
    // Nothing is ever loaded over plain HTTP; the app makes no network requests of its own.
    allowMixedContent: false,
  },
};

export default config;
