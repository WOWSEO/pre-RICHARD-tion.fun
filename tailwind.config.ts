import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cream-glass surface (per spec: cream/glass surfaces over animated video)
        cream: {
          50: "#FBF7EE",
          100: "#F7F1E2",
          200: "#F4ECDB",
          300: "#EBE0C6",
        },
        ink: {
          50: "#3D404A",
          100: "#1F2126",
          200: "#0E0F12",
        },
        // Neon green for YES (per spec)
        yes: {
          DEFAULT: "#74FF3D",
          glow: "#A6FF7A",
          deep: "#3DC91A",
        },
        // Cyber red/pink for NO (per spec)
        no: {
          DEFAULT: "#FF3D6F",
          glow: "#FF7A99",
          deep: "#C9244F",
        },
        cyber: {
          magenta: "#B23BFF",
          cyan: "#3DFFFC",
          amber: "#FFB23B",
        },
      },
      fontFamily: {
        // Distinctive, character-forward — not Inter / Roboto / Arial
        display: ['"Unbounded"', "system-ui", "sans-serif"],
        sans: ['"Sora"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      boxShadow: {
        glass: "0 20px 60px -20px rgba(14, 15, 18, 0.55), 0 4px 16px -8px rgba(14, 15, 18, 0.35)",
        "glass-lift": "0 32px 80px -20px rgba(14, 15, 18, 0.65), 0 6px 20px -6px rgba(14, 15, 18, 0.4)",
        "yes-glow": "0 0 32px -4px rgba(116, 255, 61, 0.55)",
        "no-glow": "0 0 32px -4px rgba(255, 61, 111, 0.55)",
      },
      backdropBlur: {
        xs: "2px",
      },
      animation: {
        "float-slow": "float 12s ease-in-out infinite",
        "float-med": "float 9s ease-in-out infinite",
        "float-fast": "float 7s ease-in-out infinite",
        "fade-up": "fade-up 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "scan": "scan 4s linear infinite",
        "shimmer": "shimmer 3s linear infinite",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px) rotate(var(--tw-rotate, 0))" },
          "50%": { transform: "translateY(-12px) rotate(var(--tw-rotate, 0))" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
