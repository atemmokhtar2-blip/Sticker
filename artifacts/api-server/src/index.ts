import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/whatsapp";
import fs from "node:fs";
import path from "node:path";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Ensure required directories exist
for (const dir of ["data", "sessions"]) {
  const dirPath = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start WhatsApp bot
  await startBot();
});
