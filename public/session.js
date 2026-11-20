import { BehaviorTracker, reviewThreshold } from './behavior.js';
import { loadFaceEngine } from './face-engine.js';
import { GazeTracker } from './gaze.js';
import { laptopId, objectLabels, personId, phoneId } from './object-classes.js';

const byId = (id) => document.getElementById(id);
const video = byId('camera');
const overlay = byId('overlay');
const context = overlay.getContext('2d');
const startButton = byId('start');
const downloadButton = byId('download');
const riskMeter = byId('risk-meter');
const riskResetButton = byId('reset-risk');

byId('risk-threshold').textContent = `Review at ${reviewThreshold}%`;
riskMeter.high = reviewThreshold - 1;

const faceInterval = 100;
const objectInterval = 200;
const objectMaximumGap = 2200;
const faceMaximumGap = 750;
const gazeMaximumGap = 400;
const warningResetGap = 2000;
const tabAwayThreshold = 2000;
const tabWarningDuration = 5000;
const signalIds = ['people', 'phone', 'laptop', 'face-presence', 'head', 'gaze', 'mouth', 'exam-tab'];

let session = null;
let recording = null;

startButton.addEventListener('click', () => {
  if (session) void stopSession(session);
  else void startSession();
});
downloadButton.addEventListener('click', downloadRecording);
riskResetButton.addEventListener('click', resetRisk);
window.addEventListener('pagehide', () => {
  if (session) void stopSession(session);
});

document.addEventListener('visibilitychange', () => {
  const current = session;
  if (!isActive(current)) return;
  const now = performance.now();
  if (document.hidden) {
    current.tabHiddenAt = now;
    current.tracker.clear('tab');
    window.speechSynthesis?.cancel();
  } else if (current.tabHiddenAt !== null) {
    const awayFor = now - current.tabHiddenAt;
    current.tabHiddenAt = null;
    if (awayFor >= tabAwayThreshold) {
      current.tabAwaySeconds = awayFor / 1000;
      current.tracker.update('tab', { tabAway: true }, now, tabWarningDuration);
    }
  }
  current.tracker.clear('face');
  current.tracker.clear('facePresence');
  current.tracker.clear('gaze');
  current.tracker.clear('objects');
  current.lastFace = null;
  current.lastObjects = null;
  current.visibleSince = now;
  clearOverlay();
  render(current, current.visibleSince);
  log(current, document.hidden ? 'Monitoring paused while the tab is hidden' : 'Monitoring resumed');
});

async function startSession() {
  showError('');
  const current = {
    state: 'starting',
    startedAt: performance.now(),
    tracker: new BehaviorTracker(),
    gaze: new GazeTracker(),
    visibleSince: performance.now(),
    lastVideoTime: -1,
    lastFaceAt: -Infinity,
    lastObjectRequest: -Infinity,
    flagCount: 0,
    peakRisk: 0,
    tabHiddenAt: null,
    activeFlags: new Set(),
    lastFlagSeen: new Map(),
  };
  session = current;
  byId('events').replaceChildren();
  byId('log-empty').hidden = false;
  byId('flag-count').textContent = '0 flags';
  byId('elapsed').textContent = '00:00';
  setRisk(0, 0);
  byId('risk-label').textContent = 'Malpractice risk';
  byId('peak-risk').hidden = false;
  setPhase('loading', 'Requesting camera');
  byId('camera-status').textContent = 'Waiting for camera permission';
  byId('empty-title').textContent = 'Waiting for camera access';
  byId('empty-description').textContent = 'Allow camera access in your browser to continue.';
  byId('assessment').textContent = 'Starting';
  startButton.textContent = 'Cancel';
  downloadButton.disabled = true;

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires a supported browser and a secure connection.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
    if (session !== current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    current.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => void stopSession(current, 'The camera disconnected or access was revoked.'));
    }
    video.srcObject = stream;
    await deadline(video.play(), 15_000, 'The camera did not start in time.');
    if (session !== current) return;

    video.hidden = false;
    overlay.hidden = false;
    byId('empty').hidden = true;
    setPhase('loading', 'Loading detectors');
    byId('camera-status').textContent = 'Loading models. Look at the screen to calibrate eye gaze.';
    const [face, provider] = await deadline(Promise.all([loadFaceEngine(), loadObjectEngine(current)]),
      90_000, 'Model loading timed out. Check your connection and try again.');
    if (session !== current || current.state !== 'starting') return;

    current.face = face;
    current.provider = provider;
    current.startedAt = performance.now();
    current.visibleSince = current.startedAt;
    current.state = 'active';
    if (document.hidden) current.tabHiddenAt = current.startedAt;
    recording = null;
    setPhase('active', 'Session active');
    startButton.textContent = 'End session';
    startButton.classList.add('stop');
    log(current, 'Session started');
    startRecording(current);
    render(current, performance.now());
    current.requestFrame = requestAnimationFrame((now) => processFrame(current, now));
  } catch (error) {
    if (session === current && current.state !== 'stopping') {
      await stopSession(current, describeError(error));
    }
  }
}

function loadObjectEngine(current) {
  return new Promise((resolve, reject) => {
    current.cancelWorkerLoad = () => reject(new Error('Session closed.'));
    const worker = new Worker('/object-engine.js', { type: 'module' });
    current.worker = worker;
    const failed = (message) => {
      if (isActive(current)) void stopSession(current, `Object detection stopped. ${message}`);
      else reject(new Error(message));
    };
    worker.onerror = (event) => failed(event.message || 'The object detector could not start.');
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        current.cancelWorkerLoad = null;
        resolve(data.provider);
      } else if (data.type === 'failure') {
        failed(data.message || 'The object detector could not analyze a frame.');
      } else if (data.type === 'detections') {
        current.waitingForObjects = false;
        if (!isActive(current) || document.hidden || data.timestamp < current.visibleSince) return;
        acceptObjects(current, data.detections, data.timestamp);
      }
    };
    worker.postMessage({ type: 'load' });
  });
}

function processFrame(current, now) {
  if (!isActive(current)) return;
  try {
    if (!document.hidden && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (current.waitingForObjects && now - current.lastObjectRequest > 15_000) {
        throw new Error('Object detection stopped responding. Start a new session to retry.');
      }
      if (video.currentTime !== current.lastVideoTime) {
        current.lastVideoTime = video.currentTime;
        if (now - current.lastFaceAt >= faceInterval) {
          current.lastFaceAt = now;
          const observation = current.face(video, now);
          const gaze = current.gaze.read(observation.gaze, observation.head === 'Center');
          current.lastFace = { ...observation, gaze, time: now };
          if (!observation.head || observation.head !== 'Center') {
            current.tracker.clear('gaze');
          } else if (gaze === 'Down' || gaze === 'Forward') {
            // Short blinks leave the timer intact. A longer gap breaks continuity.
            current.tracker.update('gaze', { down: gaze === 'Down' }, now, gazeMaximumGap);
          }
          current.tracker.update('face', {
            away: Boolean(observation.head && observation.head !== 'Center'),
            mouth: observation.mouthOpen === true,
          }, now, faceMaximumGap);
          const objects = readRecentObjects(current, now);
          current.tracker.update('facePresence', {
            faceMissing: objects?.people === 1 && !observation.present,
          }, now, faceMaximumGap);
        }
        if (!current.waitingForObjects && now - current.lastObjectRequest >= objectInterval) {
          void sendFrame(current, now);
        }
      }
      if (current.lastObjects && now - current.lastObjects.time > objectMaximumGap) {
        current.lastObjects = null;
        clearOverlay();
      }
    }
    if (now - (current.lastRender ?? -Infinity) >= 100) {
      current.lastRender = now;
      render(current, now);
    }
  } catch (error) {
    void stopSession(current, describeError(error));
    return;
  }
  current.requestFrame = requestAnimationFrame((time) => processFrame(current, time));
}

async function sendFrame(current, timestamp) {
  current.waitingForObjects = true;
  current.lastObjectRequest = timestamp;
  let bitmap;
  try {
    bitmap = await createImageBitmap(video);
    if (!isActive(current) || document.hidden || timestamp < current.visibleSince) {
      current.waitingForObjects = false;
      return;
    }
    current.worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
    bitmap = null;
  } catch (error) {
    if (isActive(current)) void stopSession(current, describeError(error));
  } finally {
    bitmap?.close();
  }
}

function readRecentObjects(current, now) {
  return current.lastObjects && now - current.lastObjects.time <= objectMaximumGap ? current.lastObjects : null;
}

function acceptObjects(current, detections, time) {
  const people = detections.filter(({ classId }) => classId === personId).length;
  const phone = detections.some(({ classId }) => classId === phoneId);
  const laptop = detections.some(({ classId }) => classId === laptopId);
  current.lastObjects = { people, phone, laptop, time };
  current.tracker.update('objects', { multiple: people > 1, absent: people === 0, phone, laptop },
    time, objectMaximumGap);
  if (people !== 1) current.tracker.clear('facePresence');
  drawBoxes(detections);
  render(current, performance.now());
}

function drawBoxes(detections) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  clearOverlay();
  const unit = Math.max(1, width / 600);
  context.lineWidth = 2 * unit;
  context.font = `600 ${14 * unit}px system-ui`;
  context.textBaseline = 'middle';
  for (const box of detections) {
    const isPerson = box.classId === personId;
    const color = isPerson ? '#bbfc9e' : '#ffd091';
    const label = objectLabels[box.classId];
    const x = width * (1 - box.right);
    const y = height * box.top;
    const labelHeight = 22 * unit;
    const labelY = y > labelHeight ? y - labelHeight : y;
    context.strokeStyle = color;
    context.strokeRect(x, y, width * (box.right - box.left), height * (box.bottom - box.top));
    context.fillStyle = color;
    context.fillRect(x, labelY, context.measureText(label).width + 12 * unit, labelHeight);
    context.fillStyle = '#14231a';
    context.fillText(label, x + 6 * unit, labelY + labelHeight / 2);
  }
}

function clearOverlay() {
  context.clearRect(0, 0, overlay.width, overlay.height);
}

function render(current, now) {
  const paused = document.hidden;
  const face = current.lastFace && now - current.lastFace.time <= faceMaximumGap ? current.lastFace : null;
  const objects = readRecentObjects(current, now);
  const { seconds, risk, flags } = current.tracker.read(now);
  const needsReview = risk >= reviewThreshold;
  const activeKeys = new Set(flags.map(({ key }) => key));
  const newFlags = flags.filter(({ key }) => !current.activeFlags.has(key));
  const newAnnouncements = newFlags.filter(({ key }) =>
    now - (current.lastFlagSeen.get(key) ?? -Infinity) >= warningResetGap);
  for (const flag of newFlags) log(current, flag.reason, flag.weight);
  for (const { key } of flags) current.lastFlagSeen.set(key, now);
  current.activeFlags = activeKeys;

  const alertBox = byId('alert');
  const possibleCheating = flags.some((flag) => flag.possibleCheating);
  const title = possibleCheating ? 'Exam warning: Possible cheating detected' : 'Exam warning';
  alertBox.classList.toggle('review', needsReview);
  alertBox.hidden = flags.length === 0;
  if (flags.length) {
    setText(byId('alert-title'), title);
    setText(byId('alert-details'), flags.map(({ warning }) => warning).join(' '));
  }
  if (newAnnouncements.length) announceWarning(newAnnouncements);
  current.peakRisk = Math.max(current.peakRisk, risk);
  setRisk(risk, current.peakRisk);
  setText(byId('elapsed'), formatTime((now - current.startedAt) / 1000));
  setText(byId('camera-status'), paused ? 'Monitoring paused while the tab is hidden' :
    `Analyzing locally · ${current.provider}`);
  const ready = face && objects;
  signal('assessment', paused ? 'Paused' : needsReview ? 'Review flagged' : flags.length ? 'Warning' :
    ready ? 'Monitoring' : 'Sampling',
    flags.length ? 'warn' : ready && !paused ? 'good' : 'neutral');
  const waiting = paused ? 'Paused' : 'Sampling';
  signal('people', objects ? String(objects.people) : waiting,
    objects ? objects.people === 1 ? 'good' : 'warn' : 'neutral');
  signal('phone', objects ? objects.phone ? withDuration('Visible', seconds.phone) : 'Clear' : waiting,
    objects ? objects.phone ? 'warn' : 'good' : 'neutral');
  signal('laptop', objects ? objects.laptop ? withDuration('Visible', seconds.laptop) : 'Clear' : waiting,
    objects ? objects.laptop ? 'warn' : 'good' : 'neutral');
  const facePresence = face?.present ? 'Visible' : withDuration('Out of view', seconds.faceMissing);
  signal('face-presence', face ? facePresence : waiting, face?.present ? 'good' : face ? 'warn' : 'neutral');
  signal('exam-tab', paused ? 'Hidden' :
    activeKeys.has('tabAway') ? withDuration('Left tab', current.tabAwaySeconds) : 'Visible',
    paused || activeKeys.has('tabAway') ? 'warn' : 'good');
  signal('head', face?.head ? withDuration(face.head, seconds.away) : face ? 'Face missing' : waiting,
    face?.head ? face.head === 'Center' ? 'good' : 'warn' : 'neutral');
  const gazeLabel = face?.gaze === 'Calibrating' ? 'Look at screen' : face?.gaze ?? waiting;
  signal('gaze', face?.gaze === 'Down' ? withDuration(gazeLabel, seconds.down) : gazeLabel,
    face?.gaze === 'Down' ? 'warn' : face?.gaze === 'Forward' ? 'good' : 'neutral');
  signal('mouth', face?.mouthOpen === true ? withDuration('Open', seconds.mouth) :
    face?.mouthOpen === false ? 'Closed' : face ? 'Face missing' : waiting,
    face?.mouthOpen === true ? 'warn' : face?.mouthOpen === false ? 'good' : 'neutral');
}

function setRisk(risk, peak) {
  setText(byId('risk'), `${risk}%`);
  if (riskMeter.value !== risk) riskMeter.value = risk;
  setText(byId('peak-risk').querySelector('strong'), `${peak}%`);
  riskResetButton.disabled = risk === 0 && peak === 0;
}

function resetRisk() {
  const current = session;
  if (!isActive(current)) {
    setRisk(0, 0);
    return;
  }
  const now = performance.now();
  current.tracker.resetRisk(now);
  current.peakRisk = 0;
  render(current, now);
  log(current, 'Malpractice percentage reset');
}

function announceWarning(flags) {
  const speech = window.speechSynthesis;
  if (!speech || typeof SpeechSynthesisUtterance !== 'function') return;
  const possibleCheating = flags.some((flag) => flag.possibleCheating);
  const prefix = possibleCheating ? 'Exam warning. Possible cheating detected.' : 'Exam warning.';
  const utterance = new SpeechSynthesisUtterance(`${prefix} ${flags.map(({ warning }) => warning).join(' ')}`);
  utterance.lang = 'en-US';
  const localVoice = speech.getVoices().find((voice) => voice.localService && voice.lang.startsWith('en'));
  if (localVoice) utterance.voice = localVoice;
  speech.speak(utterance);
}

function startRecording(current) {
  if (typeof MediaRecorder === 'undefined') {
    log(current, 'Recording is unavailable in this browser');
    return;
  }
  const formats = ['video/mp4;codecs=avc1.42001e', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
  let recorder;
  for (const mimeType of [...formats.filter((type) => MediaRecorder.isTypeSupported(type)), '']) {
    try {
      recorder = mimeType ? new MediaRecorder(current.stream, { mimeType }) : new MediaRecorder(current.stream);
      const chunks = [];
      current.recordingDone = new Promise((resolve) => {
        recorder.addEventListener('dataavailable', ({ data }) => {
          if (data.size) chunks.push(data);
        });
        recorder.addEventListener('stop', () => {
          const type = recorder.mimeType || chunks[0]?.type || '';
          resolve(chunks.length ? new Blob(chunks, { type }) : null);
        }, { once: true });
        recorder.addEventListener('error', () => {
          log(current, 'Recording failed');
          byId('recording').hidden = true;
          resolve(null);
        }, { once: true });
      });
      recorder.start(2000);
      current.recorder = recorder;
      byId('recording').hidden = false;
      return;
    } catch {
      current.recordingDone = null;
    }
  }
  log(current, 'Recording could not start');
}

async function stopSession(current, error = '') {
  if (session !== current || current.state === 'stopping') return;
  const wasActive = isActive(current);
  current.state = 'stopping';
  window.speechSynthesis?.cancel();
  startButton.disabled = true;
  startButton.textContent = 'Ending…';
  current.cancelWorkerLoad?.();
  current.worker?.terminate();
  cancelAnimationFrame(current.requestFrame);
  if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop();
  current.stream?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
  video.hidden = true;
  overlay.hidden = true;
  clearOverlay();
  byId('recording').hidden = true;
  byId('alert').hidden = true;
  byId('empty').hidden = false;
  byId('empty-title').textContent = wasActive ? 'Session ended' : 'Camera is off';
  byId('empty-description').textContent = 'Start a session and allow camera access.';
  byId('camera-status').textContent = 'Camera idle';
  for (const id of signalIds) signal(id, 'Waiting', 'neutral');
  signal('assessment', wasActive ? 'Session ended' : 'Standby', 'neutral');
  if (wasActive) {
    byId('risk-label').textContent = 'Session peak risk';
    byId('peak-risk').hidden = true;
    setRisk(current.peakRisk, current.peakRisk);
    log(current, 'Session ended');
  }
  if (error) showError(error);

  if (current.recordingDone) {
    recording = await deadline(current.recordingDone, 5000, 'Recording could not be finalized.').catch(() => null);
    if (recording) log(current, 'Recording ready to download');
    else log(current, 'No recording was saved');
  }
  session = null;
  setPhase('idle', 'Session offline');
  startButton.disabled = false;
  startButton.textContent = 'Start session';
  startButton.classList.remove('stop');
  downloadButton.disabled = !recording;
}

function isActive(current) {
  return current && session === current && current.state === 'active';
}

function downloadRecording() {
  if (!recording) return;
  const extension = recording.type.includes('mp4') ? 'mp4' : recording.type.includes('webm') ? 'webm' : 'video';
  const url = URL.createObjectURL(recording);
  const link = document.createElement('a');
  link.href = url;
  link.download = `proctorpulse-session.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function signal(id, text, state) {
  const node = byId(id);
  setText(node, text);
  const className = `signal ${state}`;
  if (node.className !== className) node.className = className;
}

function setPhase(state, text) {
  const element = byId('session-state');
  element.dataset.state = state;
  element.querySelector('b').textContent = text;
}

function showError(text) {
  const element = byId('error');
  element.textContent = text;
  element.hidden = !text;
}

function describeError(error) {
  switch (error.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.';
    case 'NotFoundError':
      return 'No camera was found. Connect a camera and try again.';
    case 'NotReadableError':
      return 'The camera could not be opened. Check whether another app is using it.';
    default:
      return error.message || 'The session could not continue.';
  }
}

function log(current, label, weight) {
  const timestamp = Math.max(0, (performance.now() - current.startedAt) / 1000);
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.className = 'mono';
  time.textContent = formatTime(timestamp);
  const title = document.createElement('span');
  title.textContent = label;
  const status = document.createElement('span');
  status.className = weight ? 'flag mono' : 'neutral';
  status.textContent = weight ? `${weight}% weight` : '';
  item.append(time, title, status);
  byId('log-empty').hidden = true;
  byId('events').prepend(item);
  if (byId('events').childElementCount > 150) byId('events').lastElementChild.remove();
  if (weight) {
    current.flagCount++;
    setText(byId('flag-count'), `${current.flagCount} ${current.flagCount === 1 ? 'flag' : 'flags'}`);
  }
}

function formatTime(seconds) {
  const total = Math.floor(Math.max(0, seconds));
  const pad = (value) => String(value).padStart(2, '0');
  const minutesSeconds = `${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  return total >= 3600 ? `${pad(Math.floor(total / 3600))}:${minutesSeconds}` : minutesSeconds;
}

function withDuration(text, seconds) {
  return seconds >= 0.1 ? `${text} · ${seconds.toFixed(1)} s` : text;
}

function deadline(task, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}
