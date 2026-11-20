import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const modelAssets = [
  {
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    name: 'yolo11n.onnx',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.onnx',
    sha256: '634279b40c07c6391472c51ad45b81ebc48706a9a1fe72dd3396322acd0c053b',
  },
];

async function stageModel({ name, url, sha256 }) {
  const cachePath = `.models/${name}`;
  let model = await readFile(cachePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const matches = (bytes) => bytes && createHash('sha256').update(bytes).digest('hex') === sha256;
  if (!matches(model)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Unable to download ${name}: HTTP ${response.status}`);
    model = Buffer.from(await response.arrayBuffer());
    if (!matches(model)) throw new Error(`Checksum mismatch for ${name}`);
    await writeFile(cachePath, model);
  }
  await writeFile(`dist/models/${name}`, model);
}

await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
await Promise.all([
  mkdir('dist/vendor/mediapipe', { recursive: true }),
  mkdir('dist/vendor/ort', { recursive: true }),
  mkdir('dist/models', { recursive: true }),
  mkdir('.models', { recursive: true }),
]);

const media = 'node_modules/@mediapipe/tasks-vision';
const runtime = 'node_modules/onnxruntime-web/dist';
await Promise.all([
  ...modelAssets.map(stageModel),
  cp(`${media}/vision_bundle.mjs`, 'dist/vendor/mediapipe/vision_bundle.mjs'),
  cp(`${media}/wasm`, 'dist/vendor/mediapipe/wasm', { recursive: true }),
  ...[
    'ort.webgpu.min.mjs',
    'ort.wasm.min.mjs',
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ].map((file) => cp(`${runtime}/${file}`, `dist/vendor/ort/${file}`)),
  cp('LICENSE', 'dist/LICENSE.txt'),
  cp('THIRD-PARTY-NOTICES.txt', 'dist/THIRD-PARTY-NOTICES.txt'),
  cp('licenses', 'dist/licenses', { recursive: true }),
]);
console.log('ProctorPulse built in dist/');
