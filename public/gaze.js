// MediaPipe Face Landmarker indices for each iris and its eye opening.
const eyes = [
  { corners: [33, 133], lids: [159, 145], iris: 468 },
  { corners: [362, 263], lids: [386, 374], iris: 473 },
];
const calibrationFrames = 8;

export function measureGaze(landmarks, aspect) {
  if (!landmarks?.[473] || !Number.isFinite(aspect) || aspect <= 0) return null;
  const irisPositions = eyes.map((eye) => irisPosition(landmarks, eye, aspect));
  if (irisPositions.some((position) => position === null)) return null;

  // The chin moves farther from the camera than the brow as the head tilts down.
  const brow = landmarks[168];
  const chin = landmarks[152];
  const faceHeight = Math.hypot(chin.x - brow.x, (chin.y - brow.y) * aspect);
  if (faceHeight < 0.01) return null;
  const pitch = Math.atan2(chin.z - brow.z, faceHeight) * 180 / Math.PI;
  return { irisPositions, pitch };
}

function irisPosition(landmarks, eye, aspect) {
  const [left, right] = eye.corners.map((index) => landmarks[index]);
  const [upper, lower] = eye.lids.map((index) => landmarks[index]);
  const iris = landmarks[eye.iris];
  const dx = right.x - left.x;
  const dy = (right.y - left.y) * aspect;
  const width = Math.hypot(dx, dy);
  if (dx <= 0 || width < 0.012) return null;

  // Project onto the eye's vertical axis to compensate for head roll.
  const down = (point) => (point.y - upper.y) * aspect * dx / width -
    (point.x - upper.x) * dy / width;
  const opening = down(lower);
  if (opening / width < 0.11) return null;
  const position = down(iris) / opening;
  return position >= -0.15 && position <= 1.15 ? position : null;
}

export class GazeTracker {
  samples = [];
  baseline = null;
  lookingDown = false;

  read(metrics, facingCenter) {
    if (!this.baseline) {
      if (!metrics || !facingCenter) {
        this.samples = [];
        return 'Calibrating';
      }
      this.samples.push(metrics);
      if (this.samples.length < calibrationFrames) return 'Calibrating';
      this.baseline = {
        irisPositions: [0, 1].map((side) => median(this.samples.map((sample) => sample.irisPositions[side]))),
        pitch: median(this.samples.map((sample) => sample.pitch)),
      };
      this.samples = [];
    }
    if (!metrics || !facingCenter) return 'Eyes unclear';

    const shifts = metrics.irisPositions.map((position, side) => position - this.baseline.irisPositions[side]);
    const averageShift = (shifts[0] + shifts[1]) / 2;
    const pitchChange = metrics.pitch - this.baseline.pitch;
    // Use slightly lower thresholds to keep an existing down signal stable.
    const irisDown = averageShift >= (this.lookingDown ? 0.07 : 0.11) &&
      shifts.every((shift) => shift >= 0.04);
    const headDown = pitchChange >= (this.lookingDown ? 9 : 13) &&
      shifts.every((shift) => shift >= -0.04);
    this.lookingDown = irisDown || headDown;
    return this.lookingDown ? 'Down' : 'Forward';
  }
}

function median(values) {
  const sorted = values.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
