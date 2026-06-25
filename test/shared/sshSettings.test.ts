import { describe, expect, it } from "vitest";
import { resolveSshTimeouts } from "../../src/shared/sshSettings";

describe("resolveSshTimeouts", () => {
  it("converts configured seconds to milliseconds", () => {
    expect(resolveSshTimeouts({
      sshCommandTimeoutSeconds: 15,
      sshConnectTimeoutSeconds: 10
    })).toEqual({
      commandTimeoutMs: 15_000,
      connectTimeoutMs: 10_000
    });
  });

  it("clamps invalid values to at least one second", () => {
    expect(resolveSshTimeouts({
      sshCommandTimeoutSeconds: 0,
      sshConnectTimeoutSeconds: -5
    })).toEqual({
      commandTimeoutMs: 1_000,
      connectTimeoutMs: 1_000
    });
  });
});
