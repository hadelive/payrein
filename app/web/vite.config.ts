import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ command, mode }) => {
  // A production bundle must never carry the sandbox owner key.
  if (command === "build" && loadEnv(mode, process.cwd(), "VITE_").VITE_DEV_OWNER_KEY) {
    throw new Error("VITE_DEV_OWNER_KEY is set; production builds must not include a dev signing key");
  }
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    test: { env: { VITE_NETWORK: "devnet", VITE_RPC_URL: "http://127.0.0.1:1", VITE_VAULT_ID: "vault.test", VITE_INTENTS_ID: "intents.test" } },
  };
});
