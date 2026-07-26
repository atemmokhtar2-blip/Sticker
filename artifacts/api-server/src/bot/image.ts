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

function buildWatermarkSvg(opts: WatermarkOptions): Buffer {
  const size = 512;
  const padding = 12;
  const { text, position, color, fontSize, fontFamily } = opts;

  // Calculate x/y/anchor based on position
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

  // Escape XML entities in text
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

export async function convertToSticker(imageBuffer: Buffer): Promise<Buffer> {
  const enabled = getSetting("watermark_enabled") !== "false";
  const quality = parseInt(getSetting("sticker_quality") ?? "80", 10);

  // 1. Resize to 512×512 (cover = crop to fill)
  let img = sharp(imageBuffer).resize(512, 512, { fit: "cover" });

  // 2. Overlay watermark if enabled
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

  // 3. Convert to WebP (WhatsApp sticker format)
  const webpBuffer = await img
    .webp({ quality, lossless: false })
    .toBuffer();

  return webpBuffer;
}
