import { readFace } from './behavior.js';

let landmarkerPromise;

export function loadFaceEngine() {
  if (!landmarkerPromise) {
    landmarkerPromise = initialize().catch((error) => {
      landmarkerPromise = null;
      throw error;
    });
  }
  return landmarkerPromise;
}

async function initialize() {
  const { FaceLandmarker, FilesetResolver } = await import('/vendor/mediapipe/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const detector = await FaceLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: '/models/face_landmarker.task',
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
  });
  return (video, timestamp) => readFace(detector.detectForVideo(video, timestamp).faceLandmarks[0]);
}
