# ProctorPulse

ProctorPulse is a browser-based proctoring demo. It shows a live webcam feed, flags events for review, and records a video you can download at the end of the session. Camera frames, detections, and recordings stay in the browser. The app requests camera access only, with no microphone access.

## Run locally

Requires Node.js 22 and npm. A network connection is needed for the first build to download the pinned models. The build verifies their SHA-256 checksums.

```sh
npm ci
npm run build
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000, select **Start session**, and allow camera access. When finished, select **End session** and **Download recording**. Recording uses MP4 if supported, with WebM as a fallback. Save it before starting a new session or closing the tab.

## Review rules

| Signal | Condition | Points |
| --- | --- | ---: |
| Multiple people | At least two people detected in the frame | 3 |
| Nobody present | No people detected in the frame | 3 |
| Phone | Visible for more than 3 seconds | 3 |
| Head turned | Turned left or right for more than 5 seconds | 1 |
| Mouth open | Mouth appears open for more than 4 seconds | 1 |

The total is the sum of currently active signals. Each signal displays an exam warning with the detected behavior and a suggested action. If browser speech is available, the app announces new warnings once per incident. A score of 3 or more flags the session for review while the signals are active. The activity list records each signal when it first meets its rule and again if it later clears and reappears. Head direction approximates head pose, and mouth opening is only a visual proxy for possible talking. Alerts need human review.

MediaPipe estimates face landmarks. Ultralytics YOLO11n runs in a browser worker through ONNX Runtime Web, preferring WebGPU and falling back to WebAssembly. Object inference samples the newest available frames without building a backlog. Processing cadence depends on hardware, lighting, and browser support. Keep the session tab visible while monitoring. Desktop Chrome or Edge is the starting point for use.

## Deploy on Vercel

Import the repository in Vercel. The included configuration runs `npm ci` and `npm run build` and serves `dist/`. No API keys, server functions, or database are required.

## License

AGPL-3.0-only. Third-party sources, model provenance, and notices are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
