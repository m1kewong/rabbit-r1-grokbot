# rabbit-r1-grokbot

Stark R1 is a Rabbit R1 Creation at 240 by 282 pixels. The same package speaks OpenClaw protocol 3 on `/openclaw/ws` and proxies chat to the Grok Bot bridge.

## Run locally

Install dependencies, then run the tests and the production build.

```bash
npm install
npm test
npm run build
ALLOW_ANY_TOKEN=true npm run serve
```

Open `http://127.0.0.1:18789/` for the handset. Open `http://127.0.0.1:18789/qr` for both QR codes. `?r1=1` hides the desktop bezel.

## Generate the QR images

```bash
npm run generate:qr
```

The command writes `artifacts/r1-creation-qr.png`, `artifacts/r1-openclaw-wss-qr.png`, and `artifacts/r1-dual-qr-card.png`.

Set `GATEWAY_TOKEN` before you serve a gateway that should reject unknown tokens. Set `EVEN_G2_TOKEN` when the bridge should forward to `https://even-g2-bridge.saviormike.workers.dev`. With no bridge token, chat returns the offline F.R.I.D.A.Y. sentence.

Do not deploy the Worker until Mike says yes.
