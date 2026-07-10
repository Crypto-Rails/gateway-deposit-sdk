import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `deposit-watch` lists react as a peer dependency, so make sure the SDK and the
// app share this project's single copy of react (avoids the "two Reacts" error).
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
});
