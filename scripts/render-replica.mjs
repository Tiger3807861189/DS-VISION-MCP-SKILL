#!/usr/bin/env node
// Render an HTML replica at 1734x868 and screenshot it.
//   node scripts/render-replica.mjs <replica.html> [out.png]
import { chromium } from "playwright";

const html = process.argv[2];
if (!html) { console.error("usage: node scripts/render-replica.mjs <replica.html> [out.png]"); process.exit(1); }
const out = process.argv[3] || "replica.png";
const fileUrl = html.includes("://") ? html : "file:///" + html.replace(/\\/g, "/");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1734, height: 868 } });
await page.goto(fileUrl);
await page.waitForTimeout(400);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1734, height: 868 } });
console.log("saved", out);
await browser.close();
