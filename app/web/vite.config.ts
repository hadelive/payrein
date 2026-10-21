import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  // A production bundle must never carry the sandbox owner key.
  if (command === "build" && loadEnv(mode, process.cwd(), "VITE_").VITE_DEV_OWNER_KEY) {
    throw new Error("VITE_DEV_OWNER_KEY is set; production builds must not include a dev signing key");
  }
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
  };
});
