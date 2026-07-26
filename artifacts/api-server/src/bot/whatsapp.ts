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
import { convertToSticker } from "./image";
import { getSetting } from "./settings";

const SESSIONS_DIR = path.resolve(process.cwd(), "sessions");

// Silent pino logger for baileys internals
const baileysLogger = pino({ level: "silent" });

let sock: WASocket | null = null;
let _status: "disconnected" | "connecting" | "connected" = "disconnected";
let _linkingCode: string | null = null;
let _linkedPhone: string | null = null;

// Track in-flight image processing to avoid duplicates
const processingSet = new Set<string>();

export function getBotStatus() {
  return {
    status: _status,
    linkingCode: _linkingCode,
    phone: _linkedPhone,
  };
}

async function replyText(msg: WAMessage, text: string): Promise<void> {
  if (!sock || !msg.key.remoteJid) return;
  try {
    await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
  } catch (err) {
    logger.warn({ err }, "Failed to send reply text");
  }
}

async function processImageMessage(msg: WAMessage): Promise<void> {
  if (!sock) return;
  const jid = msg.key.remoteJid!;
  const msgId = msg.key.id!;

  if (processingSet.has(msgId)) return;
  processingSet.add(msgId);

  try {
    logger.info({ jid, msgId }, "Processing image");

    // Download image
    const imageBuffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }
    )) as Buffer;

    if (!imageBuffer || imageBuffer.length === 0) {
      await replyText(msg, "❌ فشل تحميل الصورة، حاول مرة أخرى.");
      return;
    }

    // Convert to sticker WebP
    const stickerBuffer = await convertToSticker(imageBuffer);

    // Send sticker
    await sock.sendMessage(jid, { sticker: stickerBuffer });
    logger.info({ jid, msgId, sizeKB: Math.round(stickerBuffer.length / 1024) }, "✅ Sticker sent");
  } catch (err) {
    logger.error({ err, jid, msgId }, "Error processing image");
    try {
      await replyText(msg, "❌ حدث خطأ أثناء التحويل.");
    } catch {
      // ignore
    }
  } finally {
    processingSet.delete(msgId);
  }
}

async function handleIncomingMessages(messages: WAMessage[]): Promise<void> {
  // Only process messages not sent by us
  const incoming = messages.filter(
    (m) => !m.key.fromMe && m.message
  );

  const imageMessages = incoming.filter(
    (m) => m.message?.imageMessage != null
  );

  if (imageMessages.length === 0) return;

  // Notify if batch > 1
  if (imageMessages.length > 1 && imageMessages[0].key.remoteJid) {
    try {
      await sock?.sendMessage(imageMessages[0].key.remoteJid, {
        text: `⏳ جاري تحويل ${imageMessages.length} صورة إلى ملصقات...`,
      });
    } catch {
      // ignore
    }
  }

  // Process all images in parallel
  await Promise.allSettled(imageMessages.map(processImageMessage));
}

async function startConnection(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const phoneNumber = getSetting("phone_number") ?? "201044568121";

  _status = "connecting";
  _linkingCode = null;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
    // Don't mark messages as read automatically
    markOnlineOnConnect: false,
  });

  // Request pairing code if not yet registered
  // Needs a short delay for the WebSocket to connect to WhatsApp servers
  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        if (!sock) return;
        const code = await sock.requestPairingCode(phoneNumber);
        _linkingCode = code;
        logger.info(
          { code },
          `\n\n╔══════════════════════════════╗\n║   🔗  LINKING CODE           ║\n║                              ║\n║   ${code.padEnd(24)}║\n║                              ║\n║  افتح واتساب ← الأجهزة المرتبطة\n║  ← ربط جهاز ← رابط برقم هاتف\n║  ← أدخل الكود أعلاه          ║\n╚══════════════════════════════╝\n`
        );
      } catch (err) {
        logger.warn({ err }, "Could not request pairing code — may already be registered or server not ready");
      }
    }, 3000);
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    await handleIncomingMessages(messages);
  });
}

export async function startBot(): Promise<void> {
  logger.info("🤖 Starting WhatsApp Sticker Bot...");
  try {
    await startConnection();
  } catch (err) {
    logger.error({ err }, "Failed to start WhatsApp bot");
  }
}

export async function stopBot(): Promise<void> {
  if (sock) {
    sock.end(undefined);
    sock = null;
  }
  _status = "disconnected";
  _linkingCode = null;
}
