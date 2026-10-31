# rabbit-r1-grokbot

Stark R1 is a Rabbit R1 Creation at 240 by 282 pixels. The same package speaks OpenClaw protocol 3 on `/openclaw/ws` and proxies chat to the Grok Bot bridge.

## Run locally

Install dependencies, then run the tests and the production build.

```bash
npm install
npm test
npm run build
GATEWAY_TOKEN=local-dev npm run serve
```

Open `http://127.0.0.1:18789/` for the handset. Open `http://127.0.0.1:18789/qr` for both QR codes. `?r1=1` hides the desktop bezel.

`ALLOW_ANY_TOKEN=true npm run serve` is a temporary debug switch for a handset with no paired token. Anyone who can reach the worker can spend the ElevenLabs quota.

## Generate the QR images

```bash
GATEWAY_TOKEN=your-token npm run generate:qr
```

The command writes `artifacts/r1-creation-qr.png`, `artifacts/r1-openclaw-wss-qr.png`, and `artifacts/r1-dual-qr-card.png`.

Scan the Creation QR on the R1. The URL carries the token as `t`. Boot stores it and removes `t`. Without `GATEWAY_TOKEN`, the Creation URL is version-only and the OpenClaw card uses `dev-token`. The on-screen Creation card at `/qr` stays version-only. The printed card is the one that carries the token.

Set `GATEWAY_TOKEN` before you serve a gateway that should reject unknown tokens. Set `EVEN_G2_TOKEN` when the bridge should forward to `https://even-g2-bridge.saviormike.workers.dev`. With no bridge token, chat returns the offline F.R.I.D.A.Y. sentence. Chat still uses `EVEN_G2_TOKEN` on the worker. The handset does not send the paired token on `/api/chat`.

## Cloudflare secrets

```bash
wrangler secret put GATEWAY_TOKEN
wrangler secret put EVEN_G2_TOKEN
wrangler secret put ELEVENLABS_API_KEY
```

`ELEVENLABS_API_KEY` is what makes Cantonese work. Without it every hold falls back to the R1's own recognizer, which has no Cantonese.

The worker refuses to start without `GATEWAY_TOKEN` unless `ALLOW_ANY_TOKEN=true`. `ALLOW_ANY_TOKEN=true` is a temporary local debug switch for a handset that has no paired token. Anyone who can reach the worker can spend the ElevenLabs quota.

## Which recognizer heard me

The small line under the name says who took the last hold.

| Line | Meaning |
| --- | --- |
| `ASR > STANDBY` | No hold yet. |
| `ASR > ELEVENLABS SCRIBE` | Streaming to ElevenLabs. The words you speak appear live while you hold. |
| `ASR > R1 NATIVE ! <code>` | Scribe was skipped and the R1's recognizer heard you. No Cantonese. |
| `ASR > BROWSER SR ! <code>` | Same, on a desktop browser. |
| `ASR > NO MIC ! <code>` | Nothing could listen. |
| `ASR > SCRIBE ! SRV-<type>` | ElevenLabs answered with an error frame mid-hold. |

| Code | Cause |
| --- | --- |
| `AUTH` | `/api/stt/token` answered 401. The handset has no paired gateway token. |
| `NO-KEY` | `/api/stt/token` answered 503. `ELEVENLABS_API_KEY` is not set on the worker. |
| `UPSTREAM` | 502. ElevenLabs refused the key. |
| `BAD-BODY` | The worker answered with something that is not a ticket. It is probably an older build without `/api/stt/token`. |
| `NET` | The ticket request never reached the worker. |
| `HTTP-nnn` | Any other status from the worker. |
| `NO-API` | The WebView has no `getUserMedia` or `AudioContext`. |
| `MIC-DENIED`, `MIC-NONE`, `MIC-ERR` | The WebView refused or has no microphone. |
| `WS-FAIL`, `WS-CLOSED` | The socket to `api.elevenlabs.io` failed to open, or closed early. |
| `AUDIO` | The audio graph could not be built. |

After a deploy, scan the Creation QR again. The URL version changed, so the R1 loads the new build.

Do not deploy the Worker until Mike says yes.
