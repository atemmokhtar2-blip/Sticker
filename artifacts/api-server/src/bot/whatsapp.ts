import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  DisconnectReason,
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
import {
  completeDailySticker,
  saveSessionToDb,
  getSessionFromDb,
  clearSessionFromDb,
  ensureStickerUser,
  setStickerUserMode,
  reserveDailySticker,
  releaseDailySticker,
  saveBotRuntimeState,
  getBotRuntimeState,
} from "./settings";

const SESSIONS_DIR = process.env["SESSIONS_DIR"] ?? path.resolve(process.cwd(), "sessions");
const DAILY_STICKER_LIMIT = 12;
const baileysLogger = pino({ level: "silent" });

let sock: WASocket | null = null;
let _status: "disconnected" | "connecting" | "connected" = "disconnected";
let _linkingCode: string | null = null;
let _qrCode: string | null = null;
let _linkedPhone: string | null = null;
let _pairingError: string | null = null;
let _hasRegisteredSession = false;
let _lastDisconnectCode: number | null = null;
let reconnecting = false;

const processingMessages = new Set<string>();
const processingUsers = new Set<string>();
let activeConversions = 0;

async function persistBotStatus(): Promise<void> {
  try {
    await saveBotRuntimeState({
      status: _status,
      linkingCode: _linkingCode,
      qrCode: _qrCode,
      phone: _linkedPhone,
      pairingError: _pairingError,
      hasRegisteredSession: _hasRegisteredSession,
      lastDisconnectCode: _lastDisconnectCode,
    });
  } catch (err) {
    logger.error({ err }, "Failed to persist WhatsApp runtime status");
  }
}

export async function getBotStatus() {
  return getBotRuntimeState();
}

async function sendText(jid: string, text: string, quotedMsg?: WAMessage): Promise<void> {
  if (!sock) return;
  try {
    if (quotedMsg) await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
    else await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.warn({ err, jid }, "Failed to send text message");
  }
}

function getContactPhone(fallback = ""): string {
  return (process.env["PHONE_NUMBER"] ?? fallback).replace(/\D/g, "");
}

async function sendWelcomeMenu(jid: string): Promise<void> {
  if (!sock) return;
  const payload = {
    text:
      "👋 أهلاً بيك في Sticker!\n\n" +
      "حوّل صورك إلى ملصقات واتساب بسهولة.\n\n" +
      "اختار من الأزرار اللي تحت:",
    footer: "Sticker • خدمة تحويل الصور إلى ملصقات",
    buttons: [
      { buttonId: "contact_developer", buttonText: { displayText: "👨‍💻 تواصل مع المطور" }, type: 1 },
      { buttonId: "use_sticker_bot", buttonText: { displayText: "🎨 استخدام البوت" }, type: 1 },
    ],
    headerType: 1,
  };
  try {
    await sock.sendMessage(jid, payload as any);
  } catch (err) {
    logger.warn({ err, jid }, "Interactive welcome buttons unavailable; sending text fallback");
    await sendText(
      jid,
      "👋 أهلاً بيك في Sticker!\n\n" +
        "اكتب (تواصل مع المطور) علشان تبعت رسالتك هنا، أو (استخدام البوت) لبدء تحويل الصور.",
    );
  }
}

async function handleMenuChoice(jid: string, choice: string): Promise<boolean> {
  const normalized = choice.trim().toLowerCase();
  if (["contact_developer", "contact", "تواصل مع المطور", "تواصل", "1"].includes(normalized)) {
    await setStickerUserMode(jid, "contact");
    await sendText(
      jid,
      "👨‍💻 تم تحويل المحادثة لوضع التواصل مع المطور. ابعت رسالتك هنا، وهيتمكن المطور من متابعتها على نفس الرقم.\nللعودة لاستخدام البوت اكتب: استخدام البوت.",
    );
    return true;
  }
  if (["use_sticker_bot", "use", "استخدام البوت", "استخدم البوت", "2"].includes(normalized)) {
    await setStickerUserMode(jid, "active");
    await sendText(
      jid,
      "🎨 تمام! البوت جاهز ليك.\n\n" +
        "ابعت أي صورة هنا، وأنا هحوّلها لستيكر واتساب تلقائيًا.\n" +
        "الحد اليومي: " + DAILY_STICKER_LIMIT + " ستيكر لكل مستخدم.\n\n" +
        "اكتب (القائمة) لعرض الاختيارات من جديد.",
    );
    return true;
  }
  return false;
}

async function backupSessionToDb(): Promise<void> {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const files: Record<string, string> = {};
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      const filePath = path.join(SESSIONS_DIR, file);
      if (fs.lstatSync(filePath).isFile()) {
        files[file] = fs.readFileSync(filePath).toString("base64");
      }
    }
    if (Object.keys(files).length > 0) {
      await saveSessionToDb("main_session", JSON.stringify(files));
      logger.info({ fileCount: Object.keys(files).length }, "WhatsApp session snapshot saved");
    }
  } catch (err) {
    logger.error({ err }, "Failed to back up WhatsApp session");
  }
}

async function processAndSendSticker(jid: string, msg: WAMessage): Promise<void> {
  const msgId = msg.key.id ?? `${jid}-${Date.now()}`;
  if (processingMessages.has(msgId) || processingUsers.has(jid)) return;
  if (activeConversions >= 1) {
    await sendText(jid, "⏳ فيه طلب بيتعالج حالياً. استنى لحظة وابعت الصورة تاني.");
    return;
  }
  processingMessages.add(msgId);
  processingUsers.add(jid);
  activeConversions += 1;

  let quota: Awaited<ReturnType<typeof reserveDailySticker>> | null = null;
  try {
    quota = await reserveDailySticker(jid, msgId);
    if (!quota.allowed) {
      await sendText(jid, "⏳ وصلت للحد اليومي (" + DAILY_STICKER_LIMIT + " ستيكر).\nارجع بكرة وهتقدر تستخدم البوت من جديد.");
      return;
    }
    logger.info({ msgId, jid }, "Processing user image");
    const imageBuffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: baileysLogger, reuploadRequest: async (message: WAMessage) => message },
    )) as Buffer;

    if (!imageBuffer?.length) throw new Error("Empty image buffer");
    const stickerBuffer = await convertToSticker(imageBuffer);
    if (!sock) throw new Error("WhatsApp connection is not ready");

    await sock.sendMessage(jid, { sticker: stickerBuffer });
    await completeDailySticker(jid, msgId);
    logger.info({ jid, msgId, remaining: quota.remaining }, "Sticker delivered");

    if (quota.remaining === 0) {
      await sendText(jid, "✅ ده آخر ستيكر متاح ليك النهارده. الحد هيتجدد بكرة.");
    } else {
      await sendText(jid, "✅ اتعمل الستيكر بنجاح!\nالمتبقي ليك النهارده: " + quota.remaining + " من " + DAILY_STICKER_LIMIT);
    }
  } catch (err) {
    if (quota?.allowed) await releaseDailySticker(jid, msgId);
    logger.error({ err, msgId, jid }, "Sticker conversion/delivery failed");
    await sendText(jid, "⚠️ مقدرتش أحوّل الصورة دي. جرّب صورة تانية، ومش هيتخصم من حدك اليومي.");
  } finally {
    processingMessages.delete(msgId);
    processingUsers.delete(jid);
    activeConversions = Math.max(0, activeConversions - 1);
  }
}

async function handleIncomingMessages(messages: WAMessage[]): Promise<void> {
  for (const msg of messages.filter((item) => item.message)) {
    const jid = msg.key.remoteJid;
    if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || msg.key.fromMe) continue;
    const content = msg.message;
    if (!content) continue;

    const user = await ensureStickerUser(jid);
    if (user.isNew) {
      await sendWelcomeMenu(jid);
      continue;
    }

    const buttonChoice =
      content.buttonsResponseMessage?.selectedButtonId ??
      content.templateButtonReplyMessage?.selectedId ??
      content.listResponseMessage?.singleSelectReply?.selectedRowId ??
      "";
    const textMessage = content.conversation ?? content.extendedTextMessage?.text ?? "";
    const choice = buttonChoice || textMessage;

    if (choice.trim().toLowerCase() === "القائمة" || choice.trim().toLowerCase() === "menu") {
      await setStickerUserMode(jid, "awaiting_choice");
      await sendWelcomeMenu(jid);
      continue;
    }

    if (await handleMenuChoice(jid, choice)) continue;
    if (user.mode === "contact") {
      // The same WhatsApp number is used by the developer; pause automation
      // so the owner can reply manually until the user chooses to use the bot again.
      continue;
    }
    if (user.mode === "awaiting_choice") {
      await sendText(jid, "اختار من فضلك: (تواصل مع المطور) أو (استخدام البوت).");
      continue;
    }

    if (content.imageMessage) {
      await processAndSendSticker(jid, msg);
      continue;
    }

    if (textMessage.trim()) {
      await sendText(jid, "📸 ابعت صورة علشان أحوّلها لستيكر.\nحدك اليومي 12 ستيكر. اكتب (القائمة) لعرض الاختيارات.");
    }
  }
}

async function startConnection(): Promise<void> {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  if (fs.readdirSync(SESSIONS_DIR).length === 0) {
    const savedSession = await getSessionFromDb("main_session");
    if (savedSession) {
      try {
        const files = JSON.parse(savedSession) as Record<string, string>;
        for (const [filename, content] of Object.entries(files)) {
          if (filename.includes("/") || filename.includes("\\")) continue;
          fs.writeFileSync(path.join(SESSIONS_DIR, filename), Buffer.from(content, "base64"), { mode: 0o600 });
        }
        logger.info("Existing WhatsApp session restored from database backup");
      } catch (err) {
        logger.error({ err }, "Failed to restore WhatsApp session backup");
      }
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
  const savedPhone = state.creds.me?.id?.split(":")[0]?.split("@")[0] ?? "";
  const phoneNumber = getContactPhone(savedPhone);
  _hasRegisteredSession = state.creds.registered;
  _lastDisconnectCode = null;
  _status = "connecting";
  _linkingCode = null;
  _qrCode = null;
  _pairingError = null;
  await persistBotStatus();

  // Baileys rc13 bundles a stale WhatsApp Web version that WhatsApp rejects
  // with 405. Fetch the live version from WhatsApp before opening the socket.
  const { version } = await fetchLatestWaWebVersion();
  logger.info({ version }, "Using live WhatsApp Web version");

  sock = makeWASocket({
    version,
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

  // Request the WhatsApp 8-digit pairing code for the configured phone number.
  // Baileys requires a fresh, unregistered session and an international-format number.

  if (!state.creds.registered && phoneNumber) {
    // A pairing attempt must be made only once per socket. Baileys stores the
    // pairing secret in shared credentials; requesting another code while the
    // first device-link flow is pending can overwrite the secret and invalidate
    // the response from WhatsApp. A fresh socket/session is required for retry.
    let pairingRequestStarted = false;
    const requestPairingCode = async (): Promise<void> => {
      if (
        pairingRequestStarted ||
        !sock ||
        _status !== "connecting" ||
        state.creds.registered
      ) return;

      pairingRequestStarted = true;
      try {
        logger.info("Starting a single WhatsApp pairing-code request");
        const code = await sock.requestPairingCode(phoneNumber);
        if (!/^[A-Z0-9]{8}$/.test(code)) {
          throw new Error("WhatsApp returned an invalid pairing-code format");
        }
        _linkingCode = code;
        _qrCode = null;
        _pairingError = null;
        logger.info("WhatsApp pairing-code request returned an 8-character code");
        await persistBotStatus();
      } catch (err) {
        _linkingCode = null;
        _pairingError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "WhatsApp pairing-code request failed");
        await persistBotStatus();
      }
    };
    setTimeout(() => void requestPairingCode(), 8000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      if (!_linkingCode) _qrCode = qr;
      _pairingError = null;
      logger.info("WhatsApp QR code is ready; open /api/bot/qr to display it");
      await persistBotStatus();
    }
    if (connection === "open") {
      _status = "connected";
      _linkingCode = null;
      _qrCode = null;
      _linkedPhone = phoneNumber;
      reconnecting = false;
      await backupSessionToDb();
      logger.info({ phone: phoneNumber }, "WhatsApp Sticker service connected");
      await persistBotStatus();
    }

    if (connection === "close") {
      if (pairingCodeTimer) clearTimeout(pairingCodeTimer);
      pairingCodeTimer = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      _lastDisconnectCode = statusCode ?? null;
      const disconnectMessage = lastDisconnect?.error?.message ?? "Unknown connection error";
      if (statusCode === DisconnectReason.loggedOut) {
        _pairingError = "WhatsApp رفض الجلسة المحفوظة (logged out). يلزم مسح الجلسة القديمة ثم الربط من جديد.";
      } else if (!_qrCode) {
        _pairingError = `انقطع اتصال واتساب قبل إنشاء QR. رمز الخطأ: ${statusCode ?? "غير معروف"} — ${disconnectMessage}`;
      }
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      _status = "disconnected";
      _qrCode = null;
      if (!shouldReconnect) {
        // A 401/logged-out response means the restored credentials are rejected.
        // Remove only the invalid WhatsApp auth snapshot so a clean pairing can start.
        _linkingCode = null;
        _hasRegisteredSession = false;
        _pairingError = "واتساب رفض بيانات الجلسة القديمة؛ جاري تجهيز جلسة ربط جديدة.";
      }
      logger.warn({ statusCode, shouldReconnect, disconnectMessage }, "WhatsApp connection closed");
      await persistBotStatus();

      if (!reconnecting) {
        reconnecting = true;
        setTimeout(async () => {
          try {
            if (!state.creds.registered) {
              // Never carry partial pairing credentials into a new socket. They
              // may contain an abandoned pairing secret from the previous attempt.
              fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
              fs.mkdirSync(SESSIONS_DIR, { recursive: true });
              logger.warn("Unregistered partial pairing state cleared before retry");
            } else if (!shouldReconnect) {
              await clearSessionFromDb("main_session");
              fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
              fs.mkdirSync(SESSIONS_DIR, { recursive: true });
              logger.warn("Rejected WhatsApp auth snapshot cleared; starting a fresh pairing session");
            }
            await startConnection();
          } catch (err) {
            logger.error({ err }, "WhatsApp reconnect failed");
          } finally {
            reconnecting = false;
          }
        }, 5000);
      }
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    // Do not persist an unregistered pairing state before the phone approves the code.
    // Restoring these partial credentials after a restart can trigger a 401 login rejection.
    if (state.creds.registered) {
      await backupSessionToDb();
    } else {
      logger.info("Skipping WhatsApp session backup until device pairing is confirmed");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    await handleIncomingMessages(messages);
    await backupSessionToDb();
  });
}

export async function startBot(): Promise<void> {
  await startConnection();
}


export async function stopBot(): Promise<void> {
  if (sock) {
    try { sock.end(new Error("WhatsApp daemon shutting down")); } catch (err) {
      logger.warn({ err }, "Error closing WhatsApp socket");
    }
    sock = null;
  }
  _status = "disconnected";
  _linkingCode = null;
  _qrCode = null;
  await persistBotStatus();
}
