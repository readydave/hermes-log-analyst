/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "var(--panel)",
        "panel-border": "var(--panel-border)",
        text: "var(--text)",
        muted: "var(--muted)",
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        danger: "var(--danger)",
        "danger-bg": "var(--danger-bg)",
        ok: "var(--ok)",
        "ok-bg": "var(--ok-bg)"
      },
      boxShadow: {
        glass: "0 12px 30px rgba(15, 23, 42, 0.12)"
      }
    }
  },
  plugins: []
};
