export const alertThreshold = 3;

export const rules = [
  { key: 'multiple', reason: 'Multiple people detected', duration: 0, points: 3 },
  { key: 'absent', reason: 'No person detected', duration: 0, points: 3 },
  { key: 'phone', reason: 'Phone visible for more than 3 seconds', duration: 3000, points: 3 },
  { key: 'away', reason: 'Head turned for more than 5 seconds', duration: 5000, points: 1 },
  { key: 'mouth', reason: 'Mouth open for more than 4 seconds', duration: 4000, points: 1 },
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
  }

  update(group, observations, time, maximumGap) {
    for (const [key, detected] of Object.entries(observations)) {
      const prior = this.states.get(key);
      const since = detected && prior && time - prior.last <= maximumGap ? prior.since : time;
      if (detected) this.states.set(key, { since, last: time, maximumGap, group });
      else this.states.delete(key);
    }
  }

  clear(group) {
    for (const [key, state] of this.states) {
      if (state.group === group) this.states.delete(key);
    }
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
    return { seconds, flags, score: flags.reduce((total, flag) => total + flag.points, 0) };
  }
}
