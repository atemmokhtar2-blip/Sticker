import { startBot, stopBot } from "./bot/whatsapp";
import { initDatabase } from "./bot/settings";
import { logger } from "./lib/logger";

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception in WhatsApp daemon");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection in WhatsApp daemon");
});

await initDatabase();
logger.info("Neon database initialized for WhatsApp daemon");
await startBot();

const shutdown = async (signal: string) => {
  logger.info({ signal }, "Stopping WhatsApp daemon");
  await stopBot();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
