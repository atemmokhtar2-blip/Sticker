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

// How long to wait after the last received image before prompting for caption (ms)
const IMAGE_BATCH_DEBOUNCE_MS = 1500;

// WhatsApp sticker caption max length
const STICKER_CAPTION_MAX = 65536;

// Silent pino logger for baileys internals
const baileysLogger = pino({ level: "silent" });

let sock: WASocket | null = null;
let _status: "disconnected" | "connecting" | "connected" = "disconnected";
let _linkingCode: string | null = null;
let _linkedPhone: string | null = null;

// ─── Per-JID state ──────────────────────────────────────────────────────────

/** Images collected during the current batch, waiting for caption prompt */
interface PendingBatch {
  messages: WAMessage[];
  timer: ReturnType<typeof setTimeout>;
}

/** Images already prompted and waiting for the user to send a caption text */
interface AwaitingCaption {
  messages: WAMessage[];
}

const pendingBatches = new Map<string, PendingBatch>();
const awaitingCaption = new Map<string, AwaitingCaption>();

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

/** Download + convert one image to WebP sticker (no text modification). */
async function downloadAndConvert(
  msg: WAMessage,
): Promise<Buffer | null> {
  const msgId = msg.key.id!;
  if (processingSet.has(msgId)) return null;
  processingSet.add(msgId);
  try {
    process.stdout.write(`[STEP1] downloading media msgId=${msgId}\n`);
    const imageBuffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: async (m: WAMessage) => m }
    )) as Buffer;
    process.stdout.write(`[STEP2] downloaded bytes=${imageBuffer?.length}\n`);

    if (!imageBuffer || imageBuffer.length === 0) {
      logger.warn({ msgId }, "Empty image buffer — skipping");
      return null;
    }

    process.stdout.write(`[STEP3] converting to sticker...\n`);
    const result = await convertToSticker(imageBuffer);
    process.stdout.write(`[STEP4] done stickerBytes=${result?.length}\n`);
    return result;
  } catch (err) {
    logger.error({ err, msgId }, "Error converting image to sticker");
    return null;
  } finally {
    processingSet.delete(msgId);
  }
}

// ─── Core flows ──────────────────────────────────────────────────────────────

/**
 * Called when the debounce timer fires after a batch of images.
 * Moves the batch to "awaiting caption" state and prompts the user.
 */
async function onBatchComplete(jid: string): Promise<void> {
  const batch = pendingBatches.get(jid);
  if (!batch) return;
  pendingBatches.delete(jid);

  const count = batch.messages.length;
  awaitingCaption.set(jid, { messages: batch.messages });

  logger.info({ jid, count }, "Batch complete — prompting for caption");

  await sendText(
    jid,
    `📷 تم استلام ${count} ${count === 1 ? "صورة" : "صورة"} بنجاح.\n\n` +
      `✍️ الآن أرسل الوصف الذي تريد إضافته أسفل ${count === 1 ? "الملصق" : "جميع الملصقات"}.\n\n` +
      `يدعم:\n` +
      `✅ النصوص الطويلة\n` +
      `✅ العربية والإنجليزية\n` +
      `✅ الإيموجي\n` +
      `✅ الأسطر المتعددة\n` +
      `✅ الروابط وأرقام الهواتف`
  );
}

/**
 * Called when the user sends a text message while we're awaiting a caption.
 * Processes all pending images and sends the stickers with the caption.
 */
async function onCaptionReceived(jid: string, captionRaw: string): Promise<void> {
  const session = awaitingCaption.get(jid);
  if (!session) return;
  awaitingCaption.delete(jid);

  // Trim caption (keep up to WhatsApp max for sticker caption)
  let caption = captionRaw.trim();
  let truncated = false;
  if (caption.length > STICKER_CAPTION_MAX) {
    caption = caption.slice(0, STICKER_CAPTION_MAX);
    truncated = true;
  }

  const count = session.messages.length;

  if (truncated) {
    await sendText(
      jid,
      `⚠️ الوصف طويل جداً — سيتم استخدام أول ${STICKER_CAPTION_MAX} حرف فقط.`
    );
  }

  logger.info({ jid, count, captionLength: caption.length }, "Processing batch with caption");

  // Convert all images in parallel (pure conversion, no text on image)
  const results = await Promise.allSettled(
    session.messages.map((msg) => downloadAndConvert(msg))
  );

  let sent = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      try {
        // Send sticker with caption — the text appears BELOW the sticker in WhatsApp
        await sock!.sendMessage(jid, {
          sticker: result.value,
          caption: caption,
        });
        sent++;
        logger.info({ jid, sizeKB: Math.round(result.value.length / 1024) }, "✅ Sticker sent");
      } catch (err) {
        logger.error({ err, jid }, "Failed to send sticker");
        failed++;
      }
    } else {
      failed++;
    }
  }

  // Summary only when batch > 1 or there were failures
  if (count > 1 || failed > 0) {
    const parts: string[] = [];
    if (sent > 0) parts.push(`✅ تم إرسال ${sent} ملصق`);
    if (failed > 0) parts.push(`❌ فشل ${failed} ملصق`);
    await sendText(jid, parts.join(" — "));
  }
}

// ─── Incoming message handler ────────────────────────────────────────────────

async function handleIncomingMessages(messages: WAMessage[]): Promise<void> {
  // Only process messages sent BY the owner (fromMe=true) — bot is personal/self-use only
  const incoming = messages.filter((m) => m.key.fromMe === true && m.message);

  for (const msg of incoming) {
    const jid = msg.key.remoteJid;
    if (!jid) continue;

    const msgContent = msg.message;
    if (!msgContent) continue;

    const isImage = msgContent.imageMessage != null;
    const textBody =
      msgContent.conversation ??
      msgContent.extendedTextMessage?.text ??
      null;

    if (isImage) {
      // ── Image: add to pending batch, reset debounce timer ──
      if (pendingBatches.has(jid)) {
        // Extend existing batch
        const batch = pendingBatches.get(jid)!;
        clearTimeout(batch.timer);
        batch.messages.push(msg);
        batch.timer = setTimeout(() => onBatchComplete(jid), IMAGE_BATCH_DEBOUNCE_MS);
      } else {
        // Start new batch
        const timer = setTimeout(() => onBatchComplete(jid), IMAGE_BATCH_DEBOUNCE_MS);
        pendingBatches.set(jid, { messages: [msg], timer });
      }
    } else if (textBody !== null && textBody.trim().length > 0) {
      // ── Text: check if we're waiting for a caption ──
      if (awaitingCaption.has(jid)) {
        await onCaptionReceived(jid, textBody);
      }
      // Otherwise ignore — bot is image-only
    }
  }
}

// ─── Connection management ───────────────────────────────────────────────────

async function startConnection(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const phoneNumber =
    process.env["PHONE_NUMBER"] ??
    getSetting("phone_number") ??
    "201044568121";

  _status = "connecting";
  _linkingCode = null;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: Browsers.macOS("Safari"),
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 3000,
    maxMsgRetryCount: 3,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: undefined,
  });

  // Request pairing code if not yet registered
  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        if (!sock) return;
        const code = await sock.requestPairingCode(phoneNumber);
        _linkingCode = code;
        logger.info(
          { pairingCode: code, phone: phoneNumber },
          `WHATSAPP PAIRING CODE: ${code} — open WhatsApp > Linked Devices > Link a Device > Link with phone number`
        );
      } catch (err) {
        logger.warn({ err }, "Could not request pairing code — may already be registered or server not ready");
      }
    }, 5000);
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

      // Clear any in-memory state on disconnect
      pendingBatches.forEach((b) => clearTimeout(b.timer));
      pendingBatches.clear();
      awaitingCaption.clear();

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
  pendingBatches.forEach((b) => clearTimeout(b.timer));
  pendingBatches.clear();
  awaitingCaption.clear();
}
