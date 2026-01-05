const ua = process.env.npm_config_user_agent || "";

if (!ua.includes("pnpm/")) {
  // eslint-disable-next-line no-console
  console.error("\nThis repo is pnpm-only.\n\nUse:\n  pnpm install\n  pnpm run dev\n");
  process.exit(1);
}

