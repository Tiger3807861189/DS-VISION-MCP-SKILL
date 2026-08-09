import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeepSeekBrowserAdapter, ProfileLock, canReturnStableResponse, dataUrlToUploadFile } from "../scripts/browser-adapter.mjs";

test("a failed browser lock contender cannot delete the active owner lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-lock-"));
  const file = path.join(directory, "browser.lock");
  const owner = new ProfileLock(file);
  const contender = new ProfileLock(file);
  try {
    await owner.acquire();
    await assert.rejects(() => contender.acquire(), /BROWSER_PROFILE_LOCKED/);
    await contender.release();
    await fs.access(file);
    await owner.release();
    await assert.rejects(() => fs.access(file));
  } finally {
    await owner.release();
    await contender.release();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("response capture cannot accept a stable pause while generation is active", () => {
  assert.equal(canReturnStableResponse(3, "generating", 3, true), false);
  assert.equal(canReturnStableResponse(2, "complete", 3, true), false);
  assert.equal(canReturnStableResponse(3, "complete", 3, false), false);
  assert.equal(canReturnStableResponse(3, "complete", 3, true), true);
});

test("visible message collection excludes hidden message and hidden-child text", async () => {
  const adapter = new DeepSeekBrowserAdapter();
  const records = [
    { visible: true, text: "visible answer" },
    { visible: false, text: "hidden thinking" },
    { visible: true, text: "visible without hidden child" },
  ];
  adapter.page = {
    locator: () => ({
      count: async () => records.length,
      nth: (index) => ({
        isVisible: async () => records[index].visible,
        innerText: async () => records[index].text,
      }),
    }),
  };
  assert.deepEqual(await adapter.visibleMessageTexts(), ["visible answer", "visible without hidden child"]);
});

test("conversation identity uses only the latest visible user message and visible attachments", async () => {
  const adapter = new DeepSeekBrowserAdapter();
  const users = [
    { visible: false, text: "hidden prompt", images: [] },
    { visible: true, text: "visible prompt", images: [{ visible: true, source: "https://media.example/a" }, { visible: false, source: "https://media.example/hidden" }] },
  ];
  adapter.page = {
    locator: () => ({
      count: async () => users.length,
      nth: (index) => ({
        isVisible: async () => users[index].visible,
        innerText: async () => users[index].text,
        locator: () => ({
          count: async () => users[index].images.length,
          nth: (imageIndex) => ({
            isVisible: async () => users[index].images[imageIndex].visible,
            getAttribute: async () => users[index].images[imageIndex].source,
          }),
        }),
      }),
    }),
  };
  const identity = await adapter.visibleConversationIdentity();
  assert.equal(identity.media_count, 1);
  assert.equal(identity.origin_media_count, 1);
  assert.match(identity.task_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(identity.media_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(identity.origin_task_fingerprint, /^[a-f0-9]{64}$/);
});

test("data URL becomes a Playwright upload payload without a temporary source path", () => {
  const file = dataUrlToUploadFile({ name: "pixel.png", source: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(file.name, "pixel.png");
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.buffer.toString("hex"), "89504e470d0a1a0a");
  assert.equal(dataUrlToUploadFile({ source: "data:image/png;charset=utf-8;base64,iVBORw0KGgo=" }).mimeType, "image/png");
  assert.throws(() => dataUrlToUploadFile({ source: "data:text/html;base64,PGgxPmhpPC9oMT4=" }), /UNSUPPORTED_INLINE_IMAGE_MIME/);
});

test("a stale browser lock from a dead process is safely recovered", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-stale-lock-"));
  const file = path.join(directory, "browser.lock");
  const lock = new ProfileLock(file);
  try {
    await fs.writeFile(file, JSON.stringify({ owner: "dead", pid: 99999999, created_at: "2000-01-01T00:00:00.000Z" }), "utf8");
    await lock.acquire();
    await lock.release();
  } finally {
    await lock.release();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
