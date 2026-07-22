import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./hooks/**/*.{ts,tsx}", "./utils/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101828",
        panel: "#151821",
        line: "#293041",
        call: "#0ea5a3",
        danger: "#f04438"
      },
      boxShadow: {
        soft: "0 18px 60px rgba(16, 24, 40, 0.18)"
      }
    }
  },
  plugins: []
};

export default config;
