import { parseEnv, startGateway, type GatewayBindings } from "../src/gateway";
import { listenGateway } from "../src/node-listen";
import { LAN_PORT } from "../src/qr";

export async function serveMain(argv: readonly string[], env: GatewayBindings): Promise<void> {
  const parsed = parseEnv(env);
  if (!parsed.ok) throw new Error(parsed.error);
  const flag = argv.indexOf("--port");
  const port = flag >= 0 ? Number(argv[flag + 1]) : LAN_PORT;
  const host = startGateway(parsed.config);
  const listening = await listenGateway(host, { port, staticDir: "dist" });
  process.stdout.write(`${listening.url}\n`);
}

await serveMain(process.argv, {
  ALLOW_ANY_TOKEN: process.env.ALLOW_ANY_TOKEN,
  GATEWAY_TOKEN: process.env.GATEWAY_TOKEN,
  EVEN_G2_BRIDGE_URL: process.env.EVEN_G2_BRIDGE_URL,
  EVEN_G2_TOKEN: process.env.EVEN_G2_TOKEN,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
});
