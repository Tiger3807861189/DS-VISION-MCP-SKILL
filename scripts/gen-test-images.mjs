// Generate test images for DS-VISION E2E testing
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", ".ds-vision", "test-media");
fs.mkdirSync(outDir, { recursive: true });

// Create a simple 400x300 PNG with distinguishable content using pure Node.js
// PNG format: signature + IHDR + IDAT(s) + IEND

function createPNG(width, height, drawFn) {
  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(width * height * 4);
  drawFn(pixels, width, height);

  // Apply filter byte (0 = None) before each row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  // Build PNG
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(pngChunk("IHDR", ihdr));

  // IDAT
  chunks.push(pngChunk("IDAT", compressed));

  // IEND
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// Simple CRC32 implementation
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc >>>= 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function setPixel(pixels, x, y, width, r, g, b, a = 255) {
  const idx = (y * width + x) * 4;
  pixels[idx] = r;
  pixels[idx + 1] = g;
  pixels[idx + 2] = b;
  pixels[idx + 3] = a;
}

function fillRect(pixels, x, y, w, h, width, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(pixels, x + dx, y + dy, width, r, g, b, a);
    }
  }
}

function drawCircle(pixels, cx, cy, radius, width, r, g, b, a = 255) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(pixels, cx + dx, cy + dy, width, r, g, b, a);
      }
    }
  }
}

// Image 1: "Color Test Card" - colored rectangles with labels
const img1 = createPNG(400, 300, (pixels, w, h) => {
  // Background: light gray
  fillRect(pixels, 0, 0, w, h, w, 240, 240, 240);
  // Red square (top-left)
  fillRect(pixels, 30, 30, 100, 80, w, 220, 50, 50);
  // Green square (top-right)
  fillRect(pixels, 270, 30, 100, 80, w, 50, 180, 50);
  // Blue square (bottom-left)
  fillRect(pixels, 30, 170, 100, 80, w, 50, 50, 200);
  // Yellow square (bottom-right)
  fillRect(pixels, 270, 170, 100, 80, w, 240, 220, 50);
  // White circle in center
  drawCircle(pixels, 200, 140, 25, w, 255, 255, 255);
  // Black border circle
  for (let dy = -26; dy <= 26; dy++) {
    for (let dx = -26; dx <= 26; dx++) {
      if (dx * dx + dy * dy <= 27 * 27 && dx * dx + dy * dy >= 25 * 25) {
        setPixel(pixels, 200 + dx, 140 + dy, w, 0, 0, 0);
      }
    }
  }
});

fs.writeFileSync(path.join(outDir, "test-card-1.png"), img1);
console.log("Created: test-card-1.png (400x300 color test card)");

// Image 2: "UI Mockup" - simulates a simple UI screenshot
const img2 = createPNG(400, 300, (pixels, w, h) => {
  // Dark background
  fillRect(pixels, 0, 0, w, h, w, 30, 30, 40);
  // Header bar
  fillRect(pixels, 0, 0, w, 50, w, 50, 55, 70);
  // Sidebar
  fillRect(pixels, 0, 50, 80, 250, w, 40, 42, 55);
  // Main content area
  fillRect(pixels, 85, 55, 310, 240, w, 45, 48, 60);
  // Card 1 in content
  fillRect(pixels, 100, 70, 130, 90, w, 60, 65, 80);
  // Card 2 in content
  fillRect(pixels, 250, 70, 130, 90, w, 60, 65, 80);
  // Status indicator (green dot)
  drawCircle(pixels, 370, 15, 6, w, 80, 230, 80);
  // Text line simulators in header
  fillRect(pixels, 100, 15, 80, 8, w, 180, 185, 200);
  fillRect(pixels, 100, 28, 60, 6, w, 140, 145, 160);
});

fs.writeFileSync(path.join(outDir, "test-card-2.png"), img2);
console.log("Created: test-card-2.png (400x300 UI mockup)");

// Image 3: "Small detail" - a small icon-like image for recognize testing
const img3 = createPNG(200, 200, (pixels, w, h) => {
  fillRect(pixels, 0, 0, w, h, w, 255, 255, 255);
  // Arrow shape pointing right
  fillRect(pixels, 40, 80, 80, 40, w, 41, 128, 185);
  // Arrow head (triangle approximated)
  const cx = 130, cy = 100;
  for (let dy = -50; dy <= 50; dy++) {
    const maxDx = 50 - Math.abs(dy);
    for (let dx = 0; dx <= maxDx; dx++) {
      setPixel(pixels, cx + dx, cy + dy, w, 41, 128, 185);
    }
  }
});

fs.writeFileSync(path.join(outDir, "test-card-3.png"), img3);
console.log("Created: test-card-3.png (200x200 arrow icon)");

console.log("\nAll test images created in:", outDir);
