import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "node:path";
import pino from "pino";
import { logger } from "../lib/logger";
import fs from "node:fs";
import { convertToSticker } from "./image";
import { getSetting, saveSessionToDb, getSessionFromDb, clearSessionFromDb } from "./settings";

const SESSIONS_DIR = process.env["SESSIONS_DIR"] ?? path.resolve(process.cwd(), "sessions");

// Silent pino logger for baileys internals
const baileysLogger = pino({ level: "silent" });

let sock: WASocket | null = null;
let _status: "disconnected" | "connecting" | "connected" = "disconnected";
let _linkingCode: string | null = null;
let _linkedPhone: string | null = null;

// Track in-flight processing to avoid duplicate deliveries
const processingSet = new Set<string>();

// ─── Public API ─────────────────────────────────────────────────────────────

export function getBotStatus() {
  return {
    status: _status,
    linkingCode: _linkingCode,
    phone: _linkedPhone,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendText(jid: string, text: string, quotedMsg?: WAMessage): Promise<void> {
  if (!sock) return;
  try {
    if (quotedMsg) {
      await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
    } else {
      await sock.sendMessage(jid, { text });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to send text message");
  }
}

/** Download + convert one image to WebP sticker with watermark. */
async function processAndSendSticker(
  jid: string,
  msg: WAMessage,
): Promise<void> {
  const msgId = msg.key.id!;
  if (processingSet.has(msgId)) return;
  processingSet.add(msgId);
  try {
    logger.info({ msgId }, "Processing image to sticker...");
    const imageBuffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: async (m: WAMessage) => m }
    )) as Buffer;

    if (!imageBuffer || imageBuffer.length === 0) {
      logger.warn({ msgId }, "Empty image buffer — skipping");
      return;
    }

    const stickerBuffer = await convertToSticker(imageBuffer);
    
    await sock!.sendMessage(jid, {
      sticker: stickerBuffer,
    });

    logger.info({ jid, msgId }, "✅ Sticker sent successfully");
  } catch (err) {
    logger.error({ err, msgId }, "Error processing sticker");
  } finally {
    processingSet.delete(msgId);
  }
}

// ─── Incoming message handler ────────────────────────────────────────────────

async function handleIncomingMessages(messages: WAMessage[]): Promise<void> {
  const incoming = messages.filter((m) => m.message);

  for (const msg of incoming) {
    const jid = msg.key.remoteJid;
    if (!jid) continue;

    const msgContent = msg.message;
    if (!msgContent) continue;

    const isImage = msgContent.imageMessage != null;

    if (isImage) {
      // Process and send sticker immediately
      await processAndSendSticker(jid, msg);
    }
  }
}

// ─── Connection management ───────────────────────────────────────────────────

async function startConnection(): Promise<void> {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  if (fs.readdirSync(SESSIONS_DIR).length === 0) {
    logger.info("Sessions folder is empty, attempting to restore from DB...");
    const savedSession = getSessionFromDb("main_session");
    if (savedSession) {
      try {
        const files = JSON.parse(savedSession);
        for (const [filename, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(SESSIONS_DIR, filename), Buffer.from(content as string, "base64"));
        }
        logger.info("✅ Session restored from DB successfully.");
      } catch (err) {
        logger.error({ err }, "Failed to restore session from DB");
      }
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const phoneNumber =
    process.env["PHONE_NUMBER"] ??
    getSetting("phone_number") ??
    "201505324892";

  _status = "connecting";
  _linkingCode = null;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: ["Ubuntu", "Chrome", "110.0.5481.178"],
    connectTimeoutMs: 90_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 5000,
    maxMsgRetryCount: 10,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60_000,
  });

  if (!state.creds.registered) {
    const cleanPhone = phoneNumber.replace(/\D/g, "");
    
    setTimeout(async () => {
      try {
        if (!sock || sock.authState.creds.registered) return;
        logger.info({ phone: cleanPhone }, "Requesting Pairing Code...");
        const code = await sock.requestPairingCode(cleanPhone);
        _linkingCode = code;
        console.log(`\n🔥 NEW PAIRING CODE FOR ${cleanPhone}: ${code}\n`);
      } catch (err: any) {
        logger.error({ err: err.message, phone: cleanPhone }, "❌ Pairing request failed.");
        if (err.output?.statusCode === 428 || err.message?.includes("Precondition Required")) {
           logger.warn("Detected Precondition Required. Clearing sessions and restarting...");
           if (fs.existsSync(SESSIONS_DIR)) {
             fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
           }
           clearSessionFromDb("main_session");
           process.exit(1);
        }
      }
    }, 15000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      _status = "connected";
      _linkingCode = null;
      _linkedPhone = phoneNumber;
      logger.info({ phone: phoneNumber }, "✅ WhatsApp Sticker Bot is CONNECTED and ready!");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      _status = "disconnected";
      _linkingCode = null;

      logger.warn({ statusCode, shouldReconnect }, "Connection closed");

      if (shouldReconnect) {
        logger.info("Reconnecting in 5 seconds...");
        setTimeout(() => startConnection(), 5000);
      } else {
        logger.error(
          "Logged out of WhatsApp. Delete the sessions/ folder and restart to re-link."
        );
      }
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        const files: Record<string, string> = {};
        const fileList = fs.readdirSync(SESSIONS_DIR);
        for (const file of fileList) {
          const filePath = path.join(SESSIONS_DIR, file);
          if (fs.lstatSync(filePath).isFile()) {
            files[file] = fs.readFileSync(filePath).toString("base64");
          }
        }
        const sessionData = JSON.stringify(files);
        saveSessionToDb("main_session", sessionData);
        logger.info("💾 Session backed up to DB successfully.");
      }
    } catch (err) {
      logger.error({ err }, "Failed to backup session to DB");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    await handleIncomingMessages(messages);
  });
}

export async function startBot(): Promise<void> {
  await startConnection();
}
