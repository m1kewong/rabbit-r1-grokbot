import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { parseEnv, startGateway } from "../src/gateway";
import { listenGateway } from "../src/node-listen";

const parsed = parseEnv({ ALLOW_ANY_TOKEN: "true", GATEWAY_TOKEN: "shot-token" });
if (!parsed.ok) throw new Error(parsed.error);

const server = await listenGateway(startGateway(parsed.config), { port: 0, staticDir: "dist" });
await mkdir("/opt/cursor/artifacts", { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1"],
});

try {
  const phone = await browser.newPage({ viewport: { width: 240, height: 282 }, deviceScaleFactor: 1 });
  await phone.goto(`${server.url}/?r1=1`, { waitUntil: "networkidle" });
  await phone.getByRole("heading", { name: "F.R.I.D.A.Y." }).waitFor();
  await phone.getByText("AGI Chief").waitFor();
  await phone.screenshot({ path: "/opt/cursor/artifacts/r1-creation-240x282.png" });
  await phone.close();

  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await desk.goto(`${server.url}/qr`, { waitUntil: "networkidle" });
  await desk.getByRole("heading", { name: "Stark R1" }).waitFor();
  await desk.waitForFunction(() => {
    const images = [...document.querySelectorAll("img.qr")];
    return (
      images.length >= 2 &&
      images.every((img) => img instanceof HTMLImageElement && img.src.startsWith("data:image") && img.naturalWidth > 0)
    );
  });
  await desk.screenshot({ path: "/opt/cursor/artifacts/r1-qr-cockpit.png" });
  await desk.close();
} finally {
  await browser.close();
  await server.close();
}
