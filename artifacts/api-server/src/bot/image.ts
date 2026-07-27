import sharp from "sharp";
import { getSetting } from "./settings";

const STICKER_SIZE = 512;
const WATERMARK_TEXT = "01044568121";

/**
 * Convert an image buffer to a WhatsApp sticker (WebP 512×512) with a watermark.
 */
export async function convertToSticker(imageBuffer: Buffer): Promise<Buffer> {
  const quality = parseInt(getSetting("sticker_quality") ?? "80", 10);

  // Create an SVG for the watermark
  // Semi-transparent background (black with 0.4 opacity)
  // White text
  const svgWatermark = `
    <svg width="${STICKER_SIZE}" height="${STICKER_SIZE}">
      <style>
        .bg { fill: rgba(0, 0, 0, 0.4); }
        .text { fill: white; font-size: 24px; font-family: sans-serif; font-weight: bold; }
      </style>
      <rect x="${STICKER_SIZE - 160}" y="${STICKER_SIZE - 40}" width="150" height="30" rx="5" class="bg" />
      <text x="${STICKER_SIZE - 150}" y="${STICKER_SIZE - 18}" class="text">${WATERMARK_TEXT}</text>
    </svg>
  `;

  const webpBuffer = await sharp(imageBuffer)
    .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover" })
    .composite([
      {
        input: Buffer.from(svgWatermark),
        top: 0,
        left: 0,
      },
    ])
    .webp({ quality, lossless: false })
    .toBuffer();

  return webpBuffer;
}
