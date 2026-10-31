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

## Cloudflare secrets

```bash
wrangler secret put GATEWAY_TOKEN
wrangler secret put EVEN_G2_TOKEN
wrangler secret put ELEVENLABS_API_KEY
```

`ELEVENLABS_API_KEY` is what makes Cantonese work. Without it every hold falls back to the R1's own recognizer, which has no Cantonese.

The worker refuses to start without `GATEWAY_TOKEN` unless `ALLOW_ANY_TOKEN=true`. `/api/stt/token` accepts only the gateway token or the bridge token, and nothing in this package puts either one on the handset. With `GATEWAY_TOKEN` set and `ALLOW_ANY_TOKEN` unset, the R1 therefore gets `AUTH` below. To let the R1 mint tickets, set `ALLOW_ANONYMOUS_STT=true`. It opens `/api/stt/token` and nothing else, so `/openclaw/ws` still needs the gateway token. Set it as a secret so a later `wrangler deploy` cannot reset it.

```bash
wrangler secret put ALLOW_ANONYMOUS_STT
```

Anyone who finds the worker URL can then spend the ElevenLabs quota. Add a Cloudflare rate limiting rule on `/api/stt/token`. A hold costs one ticket. `ALLOW_ANY_TOKEN=true` also unlocks the STT route but additionally opens the OpenClaw socket to any token, so prefer the narrow flag.

The check for the token runs before the check for the key. After `AUTH` clears you may see `NO-KEY` next.

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
| `AUTH` | `/api/stt/token` answered 401. The handset has no accepted token. |
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
