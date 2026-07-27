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
import { getSetting } from "./settings";

const SESSIONS_DIR = process.env["SESSIONS_DIR"] ?? path.resolve(process.cwd(), "sessions");

// How long to wait after the last received image before prompting for caption (ms)
const IMAGE_BATCH_DEBOUNCE_MS = 1500;

// WhatsApp text message max length
const TEXT_MAX_LENGTH = 65536;

// Delay between sending sticker and its caption (ms)
const CAPTION_DELAY_MS = 300;

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
    `✅ تم استلام ${count} ${count === 1 ? "صورة" : "صورة"}.\n\n` +
      `✍️ أرسل الآن النص (Caption) الذي تريده أسفل ${count === 1 ? "الملصق" : "الملصقات"}.\n\n` +
      `🌟 سيتم ربط النص بالملصق بشكل احترافي لضمان ظهوره بالأسفل مباشرة بدون أي تعديل على جودة الصورة.`
  );
}

/**
 * Send a single sticker then immediately send the caption text after it.
 * Baileys StickerMessage proto does NOT have a caption field, so we send
 * the text as a separate message right after the sticker.
 */
async function sendStickerWithCaption(
  jid: string,
  stickerBuffer: Buffer,
  caption: string
): Promise<boolean> {
  try {
    // 1. Send the sticker
    const sentMsg = await sock!.sendMessage(jid, {
      sticker: stickerBuffer,
    });

    // 2. Send caption text right after as a REPLY to the sticker
    // This is the most reliable "Global Way" to pair text with a sticker in WhatsApp.
    // It ensures the caption is visually attached to the sticker and doesn't get lost in group chats.
    if (caption && caption.trim().length > 0) {
      // Tiny delay ensures the sticker arrives first
      await new Promise((r) => setTimeout(r, CAPTION_DELAY_MS));
      
      await sock!.sendMessage(
        jid, 
        { 
          text: caption,
          // Using mentions or links in caption works here too
        }, 
        { 
          quoted: sentMsg,
          // ephemeralExpiration: 604800 // Optional: match chat's ephemeral setting if needed
        }
      );
    }

    logger.info(
      { jid, sizeKB: Math.round(stickerBuffer.length / 1024) },
      "✅ Sticker + caption sent"
    );
    return true;
  } catch (err) {
    logger.error({ err, jid }, "Failed to send sticker");
    return false;
  }
}

/**
 * Called when the user sends a text message while we're awaiting a caption.
 * Processes all pending images and sends the stickers with captions.
 */
async function onCaptionReceived(jid: string, captionRaw: string): Promise<void> {
  const session = awaitingCaption.get(jid);
  if (!session) return;
  awaitingCaption.delete(jid);

  // Trim caption (keep up to WhatsApp text max)
  let caption = captionRaw.trim();
  let truncated = false;
  if (caption.length > TEXT_MAX_LENGTH) {
    caption = caption.slice(0, TEXT_MAX_LENGTH);
    truncated = true;
  }

  const count = session.messages.length;

  if (truncated) {
    await sendText(
      jid,
      `⚠️ الوصف طويل جداً — سيتم استخدام أول ${TEXT_MAX_LENGTH} حرف فقط.`
    );
  }

  logger.info({ jid, count, captionLength: caption.length }, "Processing batch with caption");

  // Convert all images in parallel (pure conversion, no text on image)
  const results = await Promise.allSettled(
    session.messages.map((msg) => downloadAndConvert(msg))
  );

  let sent = 0;
  let failed = 0;

  // Send each sticker sequentially so caption stays paired with its sticker
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const success = await sendStickerWithCaption(jid, result.value, caption);
      if (success) sent++;
      else failed++;
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
  // Process all incoming messages
  const incoming = messages.filter((m) => m.message);

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
    "201122649158";

  _status = "connecting";
  _linkingCode = null;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger,
    // Final attempt: Simulate Chrome on Android (more trusted by WA for pairing codes)
    browser: ["Ubuntu", "Chrome", "110.0.5481.178"],
    connectTimeoutMs: 90_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 5000,
    maxMsgRetryCount: 10,
    markOnlineOnConnect: false, // Better to keep false during pairing
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60_000,
  });

    // Request pairing code if not yet registered
  if (!state.creds.registered) {
    // Force clear sessions if we're trying to link a new number and it fails
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
           process.exit(1); // Force restart by Railway/Docker to get fresh state
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
