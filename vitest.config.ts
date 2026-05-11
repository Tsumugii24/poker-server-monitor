import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/client/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});
