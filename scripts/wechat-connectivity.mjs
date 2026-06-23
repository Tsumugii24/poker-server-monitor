const QR_URL = "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3";
const HEADERS = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": "131073"
};

function describeCause(error) {
  const parts = [];
  let current = error;
  const seen = new Set();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    if (current.cause instanceof Error) {
      const code = current.cause.code ? ` [${current.cause.code}]` : "";
      parts.push(`${current.cause.message}${code}`);
    }
    current = current.cause;
  }

  return parts.join(" -> ");
}

async function main() {
  console.log(`Checking WeChat iLink connectivity: ${QR_URL}`);
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
    console.log(`Proxy: ${process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY}`);
  }

  try {
    const response = await fetch(QR_URL, { headers: HEADERS });
    const text = await response.text();
    console.log(`HTTP ${response.status}, body length ${text.length}`);
    if (!response.ok) {
      console.error("Unexpected HTTP status from iLink QR endpoint.");
      process.exitCode = 1;
      return;
    }
    console.log("OK: this host can reach WeChat iLink. Retry login in Settings.");
  } catch (error) {
    console.error("FAILED:", describeCause(error));
    console.error("Check firewall/VPN/DNS/proxy access to ilinkai.weixin.qq.com, then retry login.");
    process.exitCode = 1;
  }
}

await main();
