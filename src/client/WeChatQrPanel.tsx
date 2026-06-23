import QRCode from "qrcode";
import { useEffect, useState } from "react";

type WeChatQrPanelProps = {
  url: string;
  language: "en" | "zh";
};

export function WeChatQrPanel({ url, language }: WeChatQrPanelProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(null);

    void QRCode.toDataURL(url, {
      margin: 1,
      width: 200,
      errorCorrectionLevel: "M"
    })
      .then((result) => {
        if (!cancelled) setDataUrl(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <section className="wechat-qr-panel" aria-label={language === "zh" ? "微信登录二维码" : "WeChat login QR code"}>
      <div className="wechat-qr-card">
        {dataUrl ? (
          <img src={dataUrl} alt={language === "zh" ? "微信登录二维码" : "WeChat login QR code"} className="wechat-qr-image" />
        ) : error ? (
          <p className="wechat-qr-error">{error}</p>
        ) : (
          <p className="wechat-qr-loading">{language === "zh" ? "正在生成二维码…" : "Generating QR code…"}</p>
        )}
      </div>
      <div className="wechat-qr-copy">
        <strong>{language === "zh" ? "微信扫码登录 Bot" : "Scan to log in the bot"}</strong>
        <p>
          {language === "zh"
            ? "打开微信 → 扫一扫，扫描左侧二维码。扫码后在手机上确认登录。"
            : "Open WeChat → Scan, then scan the QR code on the left and confirm login on your phone."}
        </p>
        <a href={url} target="_blank" rel="noreferrer">
          {language === "zh" ? "无法扫码？在新窗口打开登录链接" : "Can't scan here? Open login link"}
        </a>
      </div>
    </section>
  );
}
