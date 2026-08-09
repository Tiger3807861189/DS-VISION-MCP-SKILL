#!/usr/bin/env node
// DS-VISION login helper: opens persistent browser, waits for user to log in to DeepSeek
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DS_VISION_DATA_DIR || path.join(__dirname, "..", ".ds-vision");
const PROFILE = path.join(DATA_DIR, "profile");

console.log("DS-VISION Login Helper");
console.log("Data directory:", DATA_DIR);
console.log("Profile directory:", PROFILE);
console.log("");
console.log("Opening browser... Please log in to DeepSeek in the browser window.");
console.log("The script will auto-detect when login is complete and close the browser.");
console.log("");

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
});

const page = context.pages()[0] || await context.newPage();
await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded" });

// Poll for textarea to appear (login success indicator)
const started = Date.now();
const timeout = 300_000; // 5 minutes for user to log in
let loggedIn = false;

while (Date.now() - started < timeout) {
  const textarea = page.locator("textarea").first();
  if (await textarea.count() && await textarea.isVisible().catch(() => false)) {
    if (!loggedIn) {
      console.log("Login detected! Waiting 5 seconds to stabilize...");
      loggedIn = true;
    }
    await page.waitForTimeout(5000);
    console.log("Login confirmed. Closing browser.");
    break;
  }
  await page.waitForTimeout(1000);
}

if (!loggedIn) {
  console.log("Timeout waiting for login. You may close the browser manually.");
  await page.waitForTimeout(600_000); // 10 more minutes
}

try {
  await context.close();
} catch {
  // browser may already be closed by user
}
console.log("Done. Profile saved at:", PROFILE);
