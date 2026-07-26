import sharp from "sharp";
import { getSetting } from "./settings";

type WatermarkPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

interface WatermarkOptions {
  text: string;
  position: WatermarkPosition;
  color: string;
  fontSize: number;
  fontFamily: string;
}

const SVG_SIZE = 512;

// Maximum caption length we'll embed in the sticker image
export const MAX_CAPTION_LENGTH = 400;

function buildWatermarkSvg(opts: WatermarkOptions): Buffer {
  const size = SVG_SIZE;
  const padding = 12;
  const { text, position, color, fontSize, fontFamily } = opts;

  let x: number, y: number, textAnchor: string;
  switch (position) {
    case "top-left":
      x = padding;
      y = padding + fontSize;
      textAnchor = "start";
      break;
    case "top-right":
      x = size - padding;
      y = padding + fontSize;
      textAnchor = "end";
      break;
    case "bottom-left":
      x = padding;
      y = size - padding;
      textAnchor = "start";
      break;
    case "center":
      x = size / 2;
      y = size / 2;
      textAnchor = "middle";
      break;
    case "bottom-right":
    default:
      x = size - padding;
      y = size - padding;
      textAnchor = "end";
      break;
  }

  const safeText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <filter id="shadow">
    <feDropShadow dx="1" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.7"/>
  </filter>
  <text
    x="${x}"
    y="${y}"
    font-family="${fontFamily}, sans-serif"
    font-size="${fontSize}"
    fill="${color}"
    text-anchor="${textAnchor}"
    filter="url(#shadow)"
    opacity="0.9"
  >${safeText}</text>
</svg>`;

  return Buffer.from(svg);
}

/**
 * Build an SVG overlay for a multi-line caption.
 * Lines are centered at the bottom with a translucent background strip.
 */
function buildCaptionSvg(caption: string): Buffer {
  const size = SVG_SIZE;
  const fontSize = 15;
  const lineHeight = fontSize + 5;
  const padding = 8;
  // Approximate max chars per line at fontSize 15 in 512px
  const maxCharsPerLine = 46;
  const maxLines = 10;

  // Split into raw lines, then word-wrap each
  const rawLines = caption.split(/\r?\n/);
  const lines: string[] = [];

  for (const rawLine of rawLines) {
    if (lines.length >= maxLines) break;
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    // Simple character-based wrap (works for CJK/emoji/Latin/Arabic)
    let remaining = rawLine;
    while (remaining.length > 0 && lines.length < maxLines) {
      lines.push(remaining.slice(0, maxCharsPerLine));
      remaining = remaining.slice(maxCharsPerLine);
    }
  }

  const blockHeight = lines.length * lineHeight + padding * 2;
  const bgY = size - blockHeight;
  const cx = size / 2;

  const textElements = lines
    .map((line, i) => {
      const safe = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const y = bgY + padding + fontSize + i * lineHeight;
      return `  <text x="${cx}" y="${y}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#FFFFFF" text-anchor="middle" filter="url(#shadow)" direction="rtl" unicode-bidi="plaintext">${safe}</text>`;
    })
    .join("\n");

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <filter id="shadow">
    <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.85"/>
  </filter>
  <rect x="0" y="${bgY}" width="${size}" height="${blockHeight}" fill="#000000" opacity="0.45" rx="0"/>
${textElements}
</svg>`;

  return Buffer.from(svg);
}

export async function convertToSticker(
  imageBuffer: Buffer,
  caption?: string
): Promise<Buffer> {
  const quality = parseInt(getSetting("sticker_quality") ?? "80", 10);

  // 1. Resize to 512×512 (cover = crop to fill)
  let img = sharp(imageBuffer).resize(SVG_SIZE, SVG_SIZE, { fit: "cover" });

  if (caption && caption.trim().length > 0) {
    // 2a. Use the user-supplied caption as the overlay
    const svgBuf = buildCaptionSvg(caption.trim());
    img = img.composite([{ input: svgBuf, top: 0, left: 0 }]);
  } else {
    // 2b. Fall back to the saved watermark setting
    const enabled = getSetting("watermark_enabled") !== "false";
    if (enabled) {
      const watermarkText = getSetting("watermark_text") ?? "01044568121";
      const position = (getSetting("watermark_position") ??
        "bottom-right") as WatermarkPosition;
      const color = getSetting("watermark_color") ?? "#FFFFFF";
      const fontSize = parseInt(getSetting("font_size") ?? "18", 10);
      const fontFamily = getSetting("font_family") ?? "Arial";

      const svgBuf = buildWatermarkSvg({
        text: watermarkText,
        position,
        color,
        fontSize,
        fontFamily,
      });
      img = img.composite([{ input: svgBuf, top: 0, left: 0 }]);
    }
  }

  // 3. Convert to WebP (WhatsApp sticker format)
  const webpBuffer = await img.webp({ quality, lossless: false }).toBuffer();

  return webpBuffer;
}
