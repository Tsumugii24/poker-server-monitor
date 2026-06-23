import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredWeChatSession } from "../../src/server/wechatStorage";

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
});
