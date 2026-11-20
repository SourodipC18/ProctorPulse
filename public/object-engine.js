import { laptopId, personId, phoneId } from './object-classes.js';

const monitoredClasses = [personId, phoneId, laptopId];
const minimumConfidence = 0.45;
const modelUrl = '/models/yolo11n.onnx';
const runtimes = {
  WebGPU: '/vendor/ort/ort.webgpu.min.mjs',
  WebAssembly: '/vendor/ort/ort.wasm.min.mjs',
};

let detector;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      detector = await initialize();
      self.postMessage({ type: 'ready', provider: detector.provider });
    } else if (data.type === 'frame' && detector) {
      const { bitmap, timestamp } = data;
      try {
        const detections = await detector.run(bitmap);
        self.postMessage({ type: 'detections', detections, timestamp });
      } finally {
        bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'failure', message: error.message });
  }
};

async function initialize() {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Object model download failed (HTTP ${response.status})`);
  const model = await response.arrayBuffer();
  if (navigator.gpu) {
    try {
      return await makeDetector(model, 'WebGPU', 'webgpu', 640);
    } catch (error) {
      console.warn('WebGPU detector unavailable. Falling back to WebAssembly.', error);
    }
  }
  return makeDetector(model, 'WebAssembly', 'wasm', 512);
}

async function makeDetector(model, provider, executionProvider, size) {
  const ort = await import(runtimes[provider]);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  const options = {
    executionProviders: [executionProvider],
    freeDimensionOverrides: { batch: 1, channels: 3, height: size, width: size },
  };
  const session = await ort.InferenceSession.create(model, options);
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  const pixels = new Float32Array(3 * size * size);

  async function run(image) {
    const geometry = letterbox(context, image, size);
    const rgba = context.getImageData(0, 0, size, size).data;
    const plane = size * size;
    for (let i = 0; i < plane; i++) {
      pixels[i] = rgba[4 * i] / 255;
      pixels[i + plane] = rgba[4 * i + 1] / 255;
      pixels[i + 2 * plane] = rgba[4 * i + 2] / 255;
    }
    return infer(geometry);
  }

  async function infer(geometry) {
    const tensor = new ort.Tensor('float32', pixels, [1, 3, size, size]);
    let results;
    try {
      results = await session.run({ [session.inputNames[0]]: tensor });
      return decode(results[session.outputNames[0]], geometry);
    } finally {
      tensor.dispose();
      if (results) for (const result of Object.values(results)) result.dispose();
    }
  }

  // Use a blank warm-up frame to verify execution and layout before reporting readiness.
  try {
    await infer({ width: size, height: size, scale: 1, x: 0, y: 0 });
  } catch (error) {
    await session.release();
    throw error;
  }
  return { provider, run };
}

function letterbox(context, image, size) {
  const { width, height } = image;
  const scale = size / Math.max(width, height);
  const x = (size - width * scale) / 2;
  const y = (size - height * scale) / 2;
  context.fillStyle = '#727272';
  context.fillRect(0, 0, size, size);
  context.drawImage(image, x, y, width * scale, height * scale);
  return { width, height, scale, x, y };
}

function decode(output, geometry) {
  const { data, dims } = output;
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 84) {
    throw new Error(`Unexpected YOLO output shape: ${dims.join(' × ')}`);
  }
  const count = dims[2];
  const candidates = [];
  for (let i = 0; i < count; i++) {
    let confidence = -Infinity;
    let classId;
    for (const id of monitoredClasses) {
      const score = data[(4 + id) * count + i];
      if (score > confidence) {
        confidence = score;
        classId = id;
      }
    }
    if (confidence < minimumConfidence) continue;

    // Assign each proposal to its strongest COCO class.
    let strongerClass = false;
    for (let k = 0; k < 80; k++) {
      if (data[(4 + k) * count + i] > confidence) {
        strongerClass = true;
        break;
      }
    }
    if (strongerClass) continue;

    const cx = data[i], cy = data[count + i];
    const w = data[2 * count + i], h = data[3 * count + i];
    const left = normalized(cx - w / 2, geometry.x, geometry.scale * geometry.width);
    const top = normalized(cy - h / 2, geometry.y, geometry.scale * geometry.height);
    const right = normalized(cx + w / 2, geometry.x, geometry.scale * geometry.width);
    const bottom = normalized(cy + h / 2, geometry.y, geometry.scale * geometry.height);
    if (right <= left || bottom <= top) continue;
    candidates.push({ classId, confidence, left, top, right, bottom });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const box of candidates.slice(0, 150)) {
    if (kept.some((prior) => prior.classId === box.classId && intersectionOverUnion(prior, box) > 0.45)) continue;
    kept.push(box);
    if (kept.length === 30) break;
  }
  return kept;
}

function normalized(value, offset, span) {
  return Math.max(0, Math.min(1, (value - offset) / span));
}

function intersectionOverUnion(a, b) {
  const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = (box) => (box.right - box.left) * (box.bottom - box.top);
  return overlap / (area(a) + area(b) - overlap);
}
