import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { parseEnv, startGateway } from "../src/gateway";
import { listenGateway } from "../src/node-listen";

const parsed = parseEnv({ ALLOW_ANY_TOKEN: "true", GATEWAY_TOKEN: "shot-token" });
if (!parsed.ok) throw new Error(parsed.error);

const server = await listenGateway(startGateway(parsed.config), { port: 0, staticDir: "dist" });
const dir = "/opt/cursor/artifacts/screenshots";
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1"],
});

try {
  const phone = await browser.newPage({ viewport: { width: 240, height: 282 }, deviceScaleFactor: 2 });
  await phone.goto(`${server.url}/?r1=1`, { waitUntil: "networkidle" });
  await phone.getByRole("heading", { name: "F.R.I.D.A.Y." }).waitFor();
  await phone.waitForFunction(() => {
    const img = document.querySelector(".neuron-gif");
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await phone.screenshot({ path: `${dir}/r1-idle-240.png` });

  await phone.getByRole("button", { name: "Hold to talk" }).click();
  await phone.getByPlaceholder("Ask anything...").waitFor();
  await phone.waitForFunction(() => {
    const img = document.querySelector(".neuron-gif");
    return (
      img instanceof HTMLImageElement &&
      (img.getAttribute("src")?.includes("neuron-listen.gif") ?? false) &&
      img.complete &&
      img.naturalWidth > 0
    );
  });
  await phone.screenshot({ path: `${dir}/r1-hold-240.png` });

  await phone.getByPlaceholder("Ask anything...").fill("Hi");
  await phone.getByRole("button", { name: "Send" }).click();
  await phone.getByText("Heard: Hi").waitFor();
  await phone.screenshot({ path: `${dir}/r1-reply-240.png` });
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
  await desk.screenshot({ path: `${dir}/r1-qr-cockpit.png` });
  await desk.close();
} finally {
  await browser.close();
  await server.close();
}
