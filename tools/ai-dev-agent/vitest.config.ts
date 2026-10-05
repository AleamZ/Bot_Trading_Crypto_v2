import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["state/**", "reports/**", "node_modules/**"],
    environment: "node"
  }
});
