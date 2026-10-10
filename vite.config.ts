import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Only VITE_* variables reach the browser bundle (Vite's default). Supabase config comes
// exclusively from VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY; never hard-code keys here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: "hidden",
    chunkSizeWarningLimit: 600,
  },
});
