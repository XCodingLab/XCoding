/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        glass: {
          bg: "var(--glass-bg-base)",
          "bg-heavy": "var(--glass-bg-heavy)",
          border: "var(--glass-border)",
          text: "var(--glass-text-primary)",
          "text-dim": "var(--glass-text-secondary)",
          highlight: "var(--glass-highlight)",
        },
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          border: "var(--surface-border)",
        },
        editor: {
          bg: "var(--surface-2)", // Editor is lighter now
          fg: "var(--vscode-foreground)",
        },
        panel: {
          bg: "var(--surface-1)", // Sidebar is darker
          border: "var(--surface-border)",
        },
        input: {
          bg: "var(--vscode-input-background)",
          fg: "var(--vscode-input-foreground)",
          border: "var(--vscode-input-border)",
        },
        brand: {
          primary: "var(--vscode-button-background)",
          hover: "var(--vscode-button-hoverBackground)",
          fg: "var(--vscode-button-foreground)",
        },
        list: {
          hover: "var(--vscode-list-hoverBackground)",
          active: "var(--vscode-list-activeSelectionBackground)",
          activeFg: "var(--vscode-list-activeSelectionForeground)",
        }
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        sm: "var(--radius-xs)",
        md: "var(--radius-sm)",
        lg: "var(--radius-md)",
        xl: "var(--radius-lg)",
        "2xl": "var(--radius-xl)",
        "3xl": "var(--radius-2xl)",
      }
    }
  },
  plugins: []
};

