import sharp from "sharp";
import { getSetting } from "./settings";

const STICKER_SIZE = 512;

/**
 * Convert an image buffer to a WhatsApp sticker (WebP 512×512).
 * The image is resized only — NO text, NO watermark, NO overlay is drawn on it.
 */
export async function convertToSticker(imageBuffer: Buffer): Promise<Buffer> {
  const quality = parseInt(getSetting("sticker_quality") ?? "80", 10);

  // Resize to 512×512 (cover = crop to fill)
  const webpBuffer = await sharp(imageBuffer)
    .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover" })
    .webp({ quality, lossless: false })
    .toBuffer();

  return webpBuffer;
}
