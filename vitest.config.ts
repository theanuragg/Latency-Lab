import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@chaos/shared-types": resolve(__dirname, "packages/shared-types/src/index.ts"),
    },
  },
});
