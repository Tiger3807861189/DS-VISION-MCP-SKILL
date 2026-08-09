import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULTS, RUN_STATES } from "./constants.mjs";

const MESSAGE_SELECTOR = ".ds-markdown.ds-assistant-message-main-content";
const USER_MESSAGE_SELECTOR = ".ds-user-message, [data-testid='user-message'], [data-testid*='user-message'], [data-role='user-message'], [class*='user-message'], .ds-message:not(:has(.ds-assistant-message-main-content)):not(:has(.ds-think-content))";
const COMPOSER_SELECTORS = [
  "textarea[placeholder]",
  "textarea",
  "[contenteditable='true'][role='textbox']",
  "[contenteditable='true']",
];
const UPLOAD_SELECTORS = [
  "input[type='file']",
  "button[aria-label*='上传']",
  "button[aria-label*='Upload']",
  "button:has-text('上传')",
  "button:has-text('Upload')",
  "[role='button']:has-text('上传')",
  "[role='button']:has-text('Upload')",
];
const NAMED_CONTROL_SELECTOR = "div,span,button,a,[role='button'],[role='switch'],[role='radio']";
const VISION_LABEL = /^识图模式$|^识图|^Vision$/i;
const DEEP_THINK_LABEL = /^深度思考$|^深度思考\s*.$|^Deep ?Think/i;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

export class DeepSeekBrowserAdapter {
  constructor(options = {}) {
    this.browserUrl = options.browserUrl || DEFAULTS.browserUrl;
    this.profileDirectory = path.resolve(options.profileDirectory || ".ds-vision/profile");
    this.lockFile = path.join(this.profileDirectory, "browser.lock");
    this.headless = options.headless === true;
    this.selectors = options.selectors || {};
    this.context = null;
    this.page = null;
    this.profileLock = new ProfileLock(this.lockFile);
    this.state = RUN_STATES.INIT;
  }

  async open() {
    await fs.mkdir(this.profileDirectory, { recursive: true });
    await this.profileLock.acquire();
    try {
      const { chromium } = await import("playwright");
      this.context = await chromium.launchPersistentContext(this.profileDirectory, {
        headless: this.headless,
        viewport: { width: 1440, height: 1000 },
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.goto(this.browserUrl, { waitUntil: "domcontentloaded" });
      this.state = RUN_STATES.BROWSER_READY;
      return { url: this.page.url(), state: this.state };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async verifyLogin() {
    this.requirePage();
    const composer = await this.findFirst(COMPOSER_SELECTORS);
    if (!composer) {
      throw new Error("LOGIN_OR_COMPOSER_NOT_VERIFIED");
    }
    this.state = RUN_STATES.LOGIN_VERIFIED;
    return { verified: true, url: this.page.url() };
  }

  async prepareConversation(session = "auto") {
    this.requirePage();
    if (session === "new") await this.startNewConversation();
    const composer = await this.findFirst(COMPOSER_SELECTORS);
    if (!composer) throw new Error("COMPOSER_NOT_FOUND");
    this.state = RUN_STATES.CONVERSATION_READY;
    return { conversation_url: this.page.url(), reused: session !== "new" };
  }

  async openConversation(conversationUrl) {
    this.requirePage();
    if (typeof conversationUrl !== "string" || !conversationUrl.startsWith("https://chat.deepseek.com/")) {
      throw new Error("INVALID_DEEPSEEK_CONVERSATION_URL");
    }
    await this.page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(150);
    const visibleMessages = await this.visibleMessageTexts();
    const conversationIdentity = await this.visibleConversationIdentity();
    this.state = RUN_STATES.CONVERSATION_READY;
    return {
      conversation_url: this.page.url(),
      reused: true,
      assistant_message_count: visibleMessages.length,
      last_response_fingerprint: visibleMessages.length ? textFingerprint(visibleMessages.at(-1)) : null,
      conversation_identity: conversationIdentity,
    };
  }

  async ensureModes() {
    this.requirePage();
    const vision = await this.ensureEnabled(this.selectors.vision || [
      "button[aria-label*='识图模式']",
      "button[aria-label*='视觉']",
      "button[aria-label*='Vision']",
      "button:has-text('识图模式')",
      "button:has-text('视觉')",
      "button:has-text('Vision')",
      "[role='radio']:has-text('识图模式')",
      "[role='button']:has-text('识图模式')",
      "[role='button']:has-text('视觉')",
    ], "VISION_MODE", VISION_LABEL);
    this.state = RUN_STATES.VISION_MODE_VERIFIED;
    const deepThink = await this.ensureEnabled(this.selectors.deepThink || [
      "button[aria-label*='深度思考']",
      "button[aria-label*='DeepThink']",
      "button:has-text('深度思考')",
      "button:has-text('DeepThink')",
      "[role='radio']:has-text('深度思考')",
      "[role='button']:has-text('深度思考')",
      "[role='button']:has-text('DeepThink')",
      ".ds-toggle-button:has-text('深度思考')",
      ".ds-toggle-button:has-text('DeepThink')",
    ], "DEEP_THINK", DEEP_THINK_LABEL);
    this.state = RUN_STATES.DEEP_THINK_VERIFIED;
    return { vision, deep_think: deepThink };
  }

  async upload(inputs) {
    this.requirePage();
    const files = inputs.map(toUploadFile);
    const previewBefore = await this.page.locator("img[src^='blob:']").count();
    const fileInput = this.page.locator("input[type='file']").first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(files);
    } else {
      const opened = await this.openUploadWithEnter(files);
      if (!opened) throw new Error("UPLOAD_CONTROL_NOT_FOUND");
    }
    await this.waitForUploadPreview(previewBefore);
    this.state = RUN_STATES.UPLOAD_COMPLETE;
    return { uploaded_count: files.length };
  }

  async sendAndCapture(prompt, options = {}) {
    this.requirePage();
    const beforeCount = (await this.visibleMessageTexts()).length;
    const composer = await this.findFirst(COMPOSER_SELECTORS);
    if (!composer) throw new Error("COMPOSER_NOT_FOUND");
    await fillComposer(composer, prompt);
    this.state = RUN_STATES.PROMPT_READY;
    await composer.click();
    await composer.press("Enter");
    if (!(await this.confirmGenerationStarted(4000))) {
      await composer.press("Enter");
      await this.confirmGenerationStarted(4000);
    }
    this.state = RUN_STATES.GENERATING;
    const response = await this.captureNewFinal(beforeCount, options);
    this.state = RUN_STATES.RESPONSE_COMPLETE;
    return { ...response, conversation_identity: await this.visibleConversationIdentity() };
  }

  async captureNewFinal(beforeCount, options = {}) {
    this.requirePage();
    const timeoutMs = options.responseTimeoutMs || DEFAULTS.responseTimeoutMs;
    const pollMs = options.responsePollMs || DEFAULTS.responsePollMs;
    const stablePolls = options.responseStablePolls || DEFAULTS.responseStablePolls;
    const started = Date.now();
    let previous = null;
    let stable = 0;
    let observedGenerating = false;
    while (Date.now() - started < timeoutMs) {
      const texts = await this.visibleMessageTexts();
      const response = texts.slice(beforeCount).join("\n").trim();
      const generationState = await this.readGenerationState();
      if (generationState === "generating") observedGenerating = true;
      if (response && response === previous) {
        stable = generationState === "complete" ? stable + 1 : 0;
        if (canReturnStableResponse(stable, generationState, stablePolls, observedGenerating)) {
          return { final_text: response, response_selector: MESSAGE_SELECTOR, conversation_url: this.page.url() };
        }
      } else {
        previous = response || null;
        stable = 0;
      }
      await this.page.waitForTimeout(pollMs);
    }
    throw new Error("RESPONSE_FINAL_TEXT_TIMEOUT");
  }

  async calibrate() {
    this.requirePage();
    const composer = await this.findFirst(COMPOSER_SELECTORS);
    const vision = await this.findFirst(this.selectors.vision || ["button:has-text('识图模式')", "button:has-text('视觉')", "button:has-text('Vision')"]) || await this.findNamedControl(VISION_LABEL);
    const deepThink = await this.findFirst(this.selectors.deepThink || ["button:has-text('深度思考')", "button:has-text('DeepThink')"]) || await this.findNamedControl(DEEP_THINK_LABEL);
    const upload = await this.findFirst(UPLOAD_SELECTORS);
    return {
      verified_at: new Date().toISOString(),
      page_url: this.page.url(),
      selectors: {
        composer: composer ? await selectorHint(composer) : null,
        vision: vision ? await selectorHint(vision) : null,
        deep_think: deepThink ? await selectorHint(deepThink) : null,
        upload: upload ? await selectorHint(upload) : null,
        final_response: MESSAGE_SELECTOR,
      },
      boundary: "Calibration records runtime controls only; it does not create visual evidence claims.",
    };
  }

  async startNewConversation() {
    const previousUrl = this.page.url();
    const previousMessages = await this.page.locator(MESSAGE_SELECTOR).count();
    const onEntryPage = previousUrl === this.browserUrl || !previousUrl.includes("/a/chat/s/");
    if (previousMessages === 0 && onEntryPage) return;
    let control = await this.findFirst([
      "button[aria-label*='新对话']",
      "button[aria-label*='New chat']",
      "button:has-text('开启新对话')",
      "button:has-text('新对话')",
      "button:has-text('New chat')",
      "[role='button']:has-text('新对话')",
      "a:has-text('新对话')",
      "[role='button']:has-text('New chat')",
      "a:has-text('New chat')",
    ]);
    if (!control) control = await this.findNamedControl(/开启新对话|新对话|New chat|New Chat/i);
    if (!control) throw new Error("NEW_CONVERSATION_CONTROL_NOT_FOUND");
    await control.click().catch(() => {});
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const currentMessages = await this.page.locator(MESSAGE_SELECTOR).count();
      if (this.page.url() !== previousUrl || currentMessages === 0) return;
      await this.page.waitForTimeout(200);
    }
    await control.click().catch(() => {});
    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2) {
      const currentMessages = await this.page.locator(MESSAGE_SELECTOR).count();
      if (this.page.url() !== previousUrl || currentMessages === 0) return;
      await this.page.waitForTimeout(200);
    }
    await this.page.goto(this.browserUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.waitForTimeout(2500);
    const currentMessages = await this.page.locator(MESSAGE_SELECTOR).count();
    if (this.page.url() !== previousUrl || currentMessages === 0) return;
    throw new Error("NEW_CONVERSATION_NOT_VERIFIED");
  }

  async ensureEnabled(selectorList, label, labelPattern) {
    const control = await this.findFirst(selectorList) || await this.findNamedControl(labelPattern);
    if (!control) throw new Error(label + "_CONTROL_NOT_FOUND");
    if (!(await isActivated(control))) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await isActivated(control)) break;
        await control.click();
        await this.page.waitForTimeout(600);
      }
    }
    if (!(await isActivated(control))) throw new Error(label + "_NOT_VERIFIED_ENABLED");
    return true;
  }

  async openUploadWithEnter(files) {
    const control = await this.findFirst(UPLOAD_SELECTORS.slice(1));
    if (!control) return false;
    const chooserPromise = this.page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
    await control.focus();
    await control.press("Enter");
    const chooser = await chooserPromise;
    if (!chooser) return false;
    await chooser.setFiles(files);
    return true;
  }

  async waitForUploadPreview(previousCount) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await this.page.locator("img[src^='blob:']").count();
      if (current > previousCount) return;
      await this.page.waitForTimeout(150);
    }
    throw new Error("UPLOAD_PREVIEW_NOT_VERIFIED");
  }

  async findFirst(selectorList) {
    for (const selector of selectorList) {
      const locator = this.page.locator(selector).first();
      if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  }

  async visibleMessageTexts() {
    const messages = this.page.locator(MESSAGE_SELECTOR);
    const count = await messages.count();
    const texts = [];
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      if (!(await message.isVisible().catch(() => false))) continue;
      const text = (await message.innerText().catch(() => "")).trim();
      if (text) texts.push(text);
    }
    return texts;
  }

  async visibleConversationIdentity() {
    const messages = this.page.locator(this.selectors.userMessages || USER_MESSAGE_SELECTOR);
    const count = await messages.count();
    const records = [];
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      if (!(await message.isVisible().catch(() => false))) continue;
      const text = (await message.innerText().catch(() => "")).trim();
      if (!text) continue;
      const images = message.locator("img");
      const imageCount = await images.count();
      const sources = [];
      for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
        const image = images.nth(imageIndex);
        if (!(await image.isVisible().catch(() => false))) continue;
        const source = await image.getAttribute("src");
        if (source) sources.push(source);
      }
      records.push({ text, sources });
    }
    if (!records.length) return null;
    const latest = records.at(-1);
    const origin = records.find((record) => record.sources.length > 0) || records[0];
    return {
      task_fingerprint: textFingerprint(latest.text),
      media_fingerprint: textFingerprint(JSON.stringify(latest.sources)),
      media_count: latest.sources.length,
      origin_task_fingerprint: textFingerprint(origin.text),
      origin_media_fingerprint: textFingerprint(JSON.stringify(origin.sources)),
      origin_media_count: origin.sources.length,
    };
  }

  async readGenerationState() {
    const controls = this.page.locator("button,[role='button'],[role='radio'],div");
    const count = Math.min(await controls.count(), 500);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const label = [
        await control.getAttribute("aria-label").catch(() => ""),
        await control.textContent().catch(() => ""),
      ].join(" ").replace(/\s+/g, " ").trim();
      if (/停止生成|停止回答|停止输出|stop generating|stop response|cancel generation/i.test(label)) return "generating";
    }
    return "complete";
  }

  async confirmGenerationStarted(timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((await this.readGenerationState()) === "generating") return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  async findNamedControl(pattern) {
    if (!pattern) return null;
    const candidates = this.page.locator(NAMED_CONTROL_SELECTOR);
    const count = Math.min(await candidates.count(), 400);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const text = ((await candidate.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!pattern.test(text)) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (box && box.width >= 10 && box.width <= 400 && box.height >= 10 && box.height <= 80) return candidate;
    }
    return null;
  }

  requirePage() {
    if (!this.page) throw new Error("BROWSER_NOT_OPEN");
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    await this.profileLock.release();
  }
}

export class ProfileLock {
  constructor(file) {
    this.file = file;
    this.handle = null;
    this.owner = null;
  }

  async acquire() {
    const record = { owner: crypto.randomUUID(), pid: process.pid, created_at: new Date().toISOString() };
    this.owner = JSON.stringify(record);
    try {
      this.handle = await fs.open(this.file, "wx");
      await this.handle.writeFile(this.owner, "utf8");
      await this.handle.sync();
    } catch (error) {
      await this.handle?.close().catch(() => {});
      this.handle = null;
      this.owner = null;
      if (error?.code === "EEXIST" && await removeStaleLock(this.file)) return this.acquire();
      if (error?.code === "EEXIST") throw new Error("BROWSER_PROFILE_LOCKED");
      throw error;
    }
  }

  async release() {
    if (!this.handle || !this.owner) return;
    const owner = this.owner;
    await this.handle.close().catch(() => {});
    this.handle = null;
    this.owner = null;
    const persistedOwner = await fs.readFile(this.file, "utf8").catch(() => null);
    if (persistedOwner === owner) await fs.unlink(this.file).catch(() => {});
  }
}

async function fillComposer(locator, prompt) {
  const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "textarea" || tag === "input") {
    await locator.fill(prompt);
    return;
  }
  await locator.click();
  await locator.press("Control+A");
  await locator.fill(prompt);
}

async function isActivated(locator) {
  return locator.evaluate((element) => {
    const carrier = element.closest("[aria-pressed], [aria-checked], [role='switch'], [class*='toggle-button']") || element;
    const aria = carrier.getAttribute("aria-pressed") || carrier.getAttribute("aria-checked");
    if (aria === "true") return true;
    const dataState = carrier.getAttribute("data-state");
    if (dataState === "on" || dataState === "checked" || dataState === "active") return true;
    return /(^|\s)(active|selected|enabled|checked)(\s|$)/i.test(carrier.className || "");
  }).catch(() => false);
}

function toUploadFile(item) {
  if (!item.source.startsWith("data:")) return item.source;
  const comma = item.source.indexOf(",");
  if (comma < 0) throw new Error("INVALID_DATA_URL_INPUT");
  const header = item.source.slice(5, comma).split(";");
  const mimeType = (header.shift() || "application/octet-stream").toLowerCase();
  const base64 = header.some((part) => part.toLowerCase() === "base64");
  const payload = item.source.slice(comma + 1);
  if (payload.length > MAX_INLINE_IMAGE_BYTES * 4) throw new Error("INLINE_IMAGE_TOO_LARGE");
  const buffer = base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  if (!INLINE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) throw new Error("UNSUPPORTED_INLINE_IMAGE_MIME");
  if (buffer.length > MAX_INLINE_IMAGE_BYTES) throw new Error("INLINE_IMAGE_TOO_LARGE");
  return { name: item.name || "inline-upload", mimeType, buffer };
}

async function removeStaleLock(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return false;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Number.isInteger(record.pid) || isProcessAlive(record.pid)) return false;
  await fs.unlink(file).catch(() => {});
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function textFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function selectorHint(locator) {
  return locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    aria_label: element.getAttribute("aria-label"),
    role: element.getAttribute("role"),
    text: (element.textContent || "").trim().slice(0, 80),
  }));
}

export function canReturnStableResponse(stablePollsObserved, generationState, requiredStablePolls, observedGenerating = false) {
  if (generationState !== "complete") return false;
  if (observedGenerating) return stablePollsObserved >= requiredStablePolls;
  return stablePollsObserved >= requiredStablePolls + 2;
}

export function dataUrlToUploadFile(item) {
  return toUploadFile(item);
}
