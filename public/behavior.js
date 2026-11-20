export const reviewThreshold = 60;

export const rules = [
  { key: 'multiple', reason: 'Multiple people detected', duration: 0, weight: 60, possibleCheating: true,
    warning: 'Multiple people detected. Make sure only you are in the camera frame.' },
  { key: 'absent', reason: 'No person detected', duration: 0, weight: 60,
    warning: 'No person detected. Please return to the camera frame.' },
  { key: 'phone', reason: 'Phone detected', duration: 0, weight: 100, possibleCheating: true,
    warning: 'Phone detected. Please put your phone away.' },
  { key: 'down', reason: 'Downward gaze for more than 3 seconds', duration: 3000, weight: 60, possibleCheating: true,
    warning: 'You appear to be looking down. Please look back at the screen.' },
  { key: 'tabAway', reason: 'Exam tab hidden for at least 2 seconds', duration: 0, weight: 60,
    warning: 'You left the exam tab. Please keep it visible during the exam.' },
  { key: 'faceMissing', reason: 'Face out of view for more than 3 seconds', duration: 3000, weight: 40,
    warning: 'Your face has been out of view. Please face the camera and keep your face visible.' },
  { key: 'laptop', reason: 'Laptop visible for more than 3 seconds', duration: 3000, weight: 40,
    warning: 'A laptop is visible in the camera frame. Please put away any extra devices.' },
  { key: 'away', reason: 'Head turned for more than 5 seconds', duration: 5000, weight: 20,
    warning: 'You appear to be looking away. Please face the screen.' },
  { key: 'mouth', reason: 'Mouth open for more than 4 seconds', duration: 4000, weight: 20,
    warning: 'Possible talking detected. Please stay quiet during the exam.' },
];

export function readFace(landmarks) {
  if (!landmarks) return { head: null, mouthOpen: null };
  const nose = landmarks[1];
  const left = landmarks[33];
  const right = landmarks[263];
  const eyeWidth = Math.abs(right.x - left.x);
  if (eyeWidth < 0.01) return { head: null, mouthOpen: null };

  // Positive x moves left on the mirrored preview.
  const offset = (nose.x - (left.x + right.x) / 2) / eyeWidth;
  const head = offset > 0.22 ? 'Left' : offset < -0.22 ? 'Right' : 'Center';
  const gap = Math.abs(landmarks[14].y - landmarks[13].y) / eyeWidth;
  return { head, mouthOpen: gap > 0.12 };
}

export class BehaviorTracker {
  constructor() {
    this.states = new Map();
    this.resetFlags = new Set();
  }

  update(group, observations, time, maximumGap) {
    for (const [key, detected] of Object.entries(observations)) {
      const prior = this.states.get(key);
      const continuous = detected && prior && time - prior.last <= maximumGap;
      const since = continuous ? prior.since : time;
      if (!continuous) this.resetFlags.delete(key);
      if (detected) this.states.set(key, { since, last: time, maximumGap, group });
      else this.states.delete(key);
    }
  }

  clear(group) {
    for (const [key, state] of this.states) {
      if (state.group === group) {
        this.states.delete(key);
        this.resetFlags.delete(key);
      }
    }
  }

  resetRisk(now) {
    this.resetFlags = new Set(this.read(now).flags.map(({ key }) => key));
  }

  read(now) {
    const seconds = {};
    const flags = [];
    for (const rule of rules) {
      const state = this.states.get(rule.key);
      if (!state || now - state.last > state.maximumGap) continue;
      const duration = state.last - state.since;
      seconds[rule.key] = duration / 1000;
      if (rule.duration === 0 || duration > rule.duration) flags.push(rule);
    }
    const risk = Math.min(100, flags.reduce((total, flag) =>
      total + (this.resetFlags.has(flag.key) ? 0 : flag.weight), 0));
    return { seconds, flags, risk };
  }
}
