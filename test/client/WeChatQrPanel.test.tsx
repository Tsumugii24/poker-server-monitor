// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WeChatQrPanel } from "../../src/client/WeChatQrPanel";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,mock")
  }
}));

describe("WeChatQrPanel", () => {
  it("renders a scannable QR image for the login URL", async () => {
    render(<WeChatQrPanel url="https://example.com/wechat-login" language="en" />);

    expect(await screen.findByAltText("WeChat login QR code")).toHaveAttribute(
      "src",
      "data:image/png;base64,mock"
    );
    expect(screen.getByText("Scan to log in the bot")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Can't scan here? Open login link" })).toHaveAttribute(
      "href",
      "https://example.com/wechat-login"
    );
  });

  it("shows Chinese copy when requested", async () => {
    render(<WeChatQrPanel url="https://example.com/wechat-login" language="zh" />);

    await waitFor(() => {
      expect(screen.getByAltText("微信登录二维码")).toBeInTheDocument();
    });
    expect(screen.getByText("微信扫码登录 Bot")).toBeInTheDocument();
  });

  it("calls the manual refresh handler", async () => {
    const onRefresh = vi.fn();
    render(<WeChatQrPanel url="https://example.com/wechat-login" language="en" onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh QR" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
