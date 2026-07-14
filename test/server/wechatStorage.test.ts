import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quarantineInvalidWeChatStorage, readStoredWeChatSession } from "../../src/server/wechatStorage";

describe("wechatStorage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads stored credentials and context tokens", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechatbot-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      userId: "bot@im.wechat",
      savedAt: "2026-06-13T10:00:00.000Z"
    }));
    fs.writeFileSync(path.join(dir, "context_tokens.json"), JSON.stringify({
      "123@im.wechat": "token-1"
    }));

    expect(readStoredWeChatSession("123@im.wechat", dir)).toEqual({
      available: true,
      botUserId: "bot@im.wechat",
      savedAt: "2026-06-13T10:00:00.000Z",
      contextUserIds: ["123@im.wechat"],
      verifiedForTarget: true
    });
  });

  it("quarantines truncated SDK state while preserving valid credentials", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechatbot-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ userId: "bot@im.wechat" }));
    fs.writeFileSync(path.join(dir, "cursor.json"), "");
    fs.writeFileSync(path.join(dir, "context_tokens.json"), '{"user@im.wechat":');

    const repairs = quarantineInvalidWeChatStorage(dir, 1234);

    expect(repairs.map((repair) => path.basename(repair.filePath))).toEqual([
      "cursor.json",
      "context_tokens.json"
    ]);
    expect(fs.existsSync(path.join(dir, "credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "cursor.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "cursor.json.corrupt-1234"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "context_tokens.json.corrupt-1234"))).toBe(true);
  });
});
