/**
 * Virtual Studio — Multi-track Web Audio Synthesizer, Step Sequencer & Orchestral Engine
 */

const $ = (selector) => document.querySelector(selector);

/* ==========================================================================
   1. Web Audio Setup & Master Routing
   ========================================================================== */
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioCtx();

const masterGain = audioCtx.createGain();
const compressor = audioCtx.createDynamicsCompressor();
masterGain.gain.value = 0.8;
masterGain.connect(compressor);
compressor.connect(audioCtx.destination);

// Session gain node allows instant fade-out & cleanup on transport stop
let sessionGain = audioCtx.createGain();
sessionGain.connect(masterGain);

// 2-second white noise buffer shared across percussion voices
const noiseBuffer = (() => {
  const length = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    channel[i] = Math.random() * 2 - 1;
  }
  return buffer;
})();

/* ==========================================================================
   2. Sound Synthesis Engine & Orchestral Profiles
   ========================================================================== */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Convert a pitch name like "C#4" into frequency in Hz.
 */
function noteToHz(noteId) {
  const match = /^([A-G]#?)(\d)$/.exec(noteId);
  const pitchClass = NOTE_NAMES.indexOf(match[1]);
  const octave = Number(match[2]);
  const midiNumber = (octave + 1) * 12 + pitchClass;
  return 440 * Math.pow(2, (midiNumber - 69) / 12);
}

/**
 * Generate a waveshaper distortion curve for guitar overdrive.
 */
function createDistortionCurve(amount) {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 128 - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/**
 * Render a multi-oscillator subtractive synth voice with ADSR and lowpass envelope.
 */
function playSynthTone(bus, patch, time, duration) {
  const envGain = audioCtx.createGain();
  const releaseGain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  // Amplitude attack & decay
  envGain.gain.setValueAtTime(0.0001, time);
  envGain.gain.linearRampToValueAtTime(patch.peak, time + patch.a);
  envGain.gain.exponentialRampToValueAtTime(patch.s, time + patch.a + patch.d);

  // Lowpass filter sweep
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(patch.lp[0], time);
  filter.frequency.exponentialRampToValueAtTime(patch.lp[1], time + patch.a + patch.d);

  const stopTime = time + duration + patch.r + 0.05;

  patch.osc.forEach(([type, multiplier, detune, level]) => {
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = patch.f * multiplier;
    osc.detune.value = detune;
    oscGain.gain.value = level;

    osc.connect(oscGain);
    oscGain.connect(envGain);
    osc.start(time);
    osc.stop(stopTime);
  });

  envGain.connect(filter);
  let outputNode = filter;

  if (patch.dist) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = createDistortionCurve(patch.dist);
    shaper.oversample = '4x';
    filter.connect(shaper);
    outputNode = shaper;
  }

  outputNode.connect(releaseGain);
  releaseGain.connect(bus);

  // Release stage at note off
  releaseGain.gain.setValueAtTime(1, time + duration);
  releaseGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + patch.r);
}

const defaultPianoVoice = (bus, id, t, dur) =>
  playSynthTone(bus, {
    f: noteToHz(id),
    osc: [['triangle', 1, 0, 0.7], ['sine', 2, 0, 0.25], ['sine', 3, 0, 0.1]],
    peak: 0.5, a: 0.005, d: 2, s: 0.05, r: 0.3,
    lp: [4500, 900],
  }, t, dur);

const defaultGuitarVoice = (bus, id, t, dur) =>
  playSynthTone(bus, {
    f: noteToHz(id),
    osc: [['sawtooth', 1, -7, 0.5], ['sawtooth', 1, 7, 0.5], ['square', 2, 0, 0.08]],
    peak: 0.4, a: 0.004, d: 1.4, s: 0.2, r: 0.12,
    lp: [4000, 1400],
    dist: 45,
  }, t, dur);

const defaultBassVoice = (bus, id, t, dur) =>
  playSynthTone(bus, {
    f: noteToHz(id),
    osc: [['sawtooth', 1, 0, 0.6], ['sine', 0.5, 0, 0.9]],
    peak: 0.75, a: 0.01, d: 0.6, s: 0.35, r: 0.15,
    lp: [1000, 260],
  }, t, dur);

/**
 * Synthesize acoustic/electronic drum hits using filtered noise and pitch-swept oscillators.
 */
function defaultDrumVoice(bus, drumId, time) {
  const triggerNoise = (filterType, freq, peak, decay, delay = 0) => {
    const src = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    const startAt = time + delay;

    src.buffer = noiseBuffer;
    filter.type = filterType;
    filter.frequency.value = freq;

    gain.gain.setValueAtTime(peak, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + decay);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    src.start(startAt);
    src.stop(startAt + decay + 0.05);
  };

  const triggerPitchSweep = (startFreq, endFreq, peak, decay, waveType = 'sine') => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = waveType;
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + decay * 0.6);

    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

    osc.connect(gain);
    gain.connect(bus);
    osc.start(time);
    osc.stop(time + decay + 0.05);
  };

  const drumMap = {
    kick: () => triggerPitchSweep(150, 42, 1.4, 0.5),
    snare: () => {
      triggerNoise('highpass', 1500, 0.8, 0.2);
      triggerPitchSweep(220, 120, 0.5, 0.12, 'triangle');
    },
    hat: () => triggerNoise('highpass', 7500, 0.45, 0.05),
    ohat: () => triggerNoise('highpass', 7500, 0.45, 0.35),
    tom1: () => triggerPitchSweep(230, 110, 1.0, 0.3),
    tom2: () => triggerPitchSweep(150, 70, 1.0, 0.42),
    crash: () => triggerNoise('highpass', 5000, 0.6, 1.5),
    clap: () => [0, 0.012, 0.026].forEach((offset) => triggerNoise('bandpass', 1500, 0.8, 0.12, offset)),
  };

  drumMap[drumId]();
}

function playBuffer(bus, buffer, time = audioCtx.currentTime + 0.01, duration = null) {
  if (!buffer) return;
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  src.buffer = buffer;
  gain.gain.value = 0.8;

  src.connect(gain);
  gain.connect(bus);
  src.start(time, 0, duration ? Math.min(duration, buffer.duration) : undefined);
}

/**
 * Orchestral and brass instrument synthesis profiles.
 */
function orchestraVoice(track, bus, id, time, duration) {
  const freq = noteToHz(id);
  const presetIndex = track.sound || 0;

  const profiles = {
    trumpet: [
      { osc: [['sawtooth', 1, 0, 0.72], ['square', 2, 4, 0.18]], peak: 0.48, a: 0.035, d: 0.45, s: 0.72, r: 0.16, lp: [5200, 1700] },
      { osc: [['sawtooth', 1, -5, 0.55], ['triangle', 2, 0, 0.12]], peak: 0.38, a: 0.055, d: 0.5, s: 0.55, r: 0.2, lp: [2600, 900] },
      { osc: [['sawtooth', 1, 0, 0.65], ['sawtooth', 1, 7, 0.2]], peak: 0.46, a: 0.018, d: 0.4, s: 0.68, r: 0.12, lp: [6500, 2100] }
    ],
    trombone: [
      { osc: [['sawtooth', 1, 0, 0.55], ['triangle', 2, -3, 0.18]], peak: 0.5, a: 0.07, d: 0.5, s: 0.75, r: 0.2, lp: [3000, 900] },
      { osc: [['triangle', 1, 0, 0.7], ['sawtooth', 2, 0, 0.12]], peak: 0.36, a: 0.1, d: 0.6, s: 0.6, r: 0.24, lp: [1900, 650] },
      { osc: [['sawtooth', 1, -4, 0.5], ['sawtooth', 1, 4, 0.5]], peak: 0.45, a: 0.04, d: 0.4, s: 0.7, r: 0.18, lp: [4200, 1200] }
    ],
    clarinet: [
      { osc: [['square', 1, 0, 0.42], ['sine', 3, 0, 0.18]], peak: 0.4, a: 0.045, d: 0.45, s: 0.72, r: 0.18, lp: [3600, 1300] },
      { osc: [['triangle', 1, 0, 0.65], ['square', 3, 0, 0.1]], peak: 0.35, a: 0.08, d: 0.6, s: 0.62, r: 0.22, lp: [2400, 850] },
      { osc: [['square', 1, 0, 0.35], ['sine', 5, 0, 0.12]], peak: 0.38, a: 0.025, d: 0.5, s: 0.7, r: 0.15, lp: [5000, 1700] }
    ],
    flute: [
      { osc: [['sine', 1, 0, 0.8], ['sine', 2, 0, 0.12]], peak: 0.32, a: 0.06, d: 0.5, s: 0.8, r: 0.22, lp: [8000, 3600] },
      { osc: [['sine', 1, 0, 0.7], ['triangle', 2, 0, 0.12]], peak: 0.25, a: 0.16, d: 0.7, s: 0.72, r: 0.35, lp: [6500, 2600] },
      { osc: [['sine', 1, 0, 0.75], ['sine', 3, 0, 0.12]], peak: 0.3, a: 0.025, d: 0.35, s: 0.65, r: 0.12, lp: [9000, 4200] }
    ],
    violin: [
      { osc: [['sawtooth', 1, -4, 0.42], ['sawtooth', 1, 4, 0.42], ['sine', 2, 0, 0.1]], peak: 0.38, a: 0.12, d: 0.5, s: 0.8, r: 0.28, lp: [5200, 1800] },
      { osc: [['triangle', 1, -3, 0.45], ['triangle', 1, 3, 0.45], ['sine', 2, 0, 0.12]], peak: 0.32, a: 0.2, d: 0.7, s: 0.78, r: 0.4, lp: [4200, 1500] },
      { osc: [['sawtooth', 1, 0, 0.5], ['square', 2, 0, 0.08]], peak: 0.4, a: 0.008, d: 0.28, s: 0.3, r: 0.08, lp: [6000, 1900] }
    ],
    cello: [
      { osc: [['sawtooth', 1, -3, 0.42], ['sawtooth', 1, 3, 0.42], ['sine', 0.5, 0, 0.2]], peak: 0.48, a: 0.13, d: 0.55, s: 0.8, r: 0.3, lp: [2600, 700] },
      { osc: [['triangle', 1, 0, 0.7], ['sine', 2, 0, 0.15]], peak: 0.4, a: 0.2, d: 0.7, s: 0.78, r: 0.38, lp: [1800, 550] },
      { osc: [['triangle', 1, 0, 0.65], ['sine', 2, 0, 0.12]], peak: 0.42, a: 0.005, d: 0.3, s: 0.08, r: 0.12, lp: [3200, 900] }
    ],
    saxophone: [
      { osc: [['sawtooth', 1, 0, 0.55], ['square', 2, 5, 0.12]], peak: 0.42, a: 0.05, d: 0.5, s: 0.72, r: 0.2, lp: [4200, 1200] },
      { osc: [['sawtooth', 1, -6, 0.4], ['triangle', 2, 0, 0.18]], peak: 0.35, a: 0.1, d: 0.6, s: 0.65, r: 0.25, lp: [3000, 850] },
      { osc: [['square', 1, 0, 0.35], ['sawtooth', 2, 0, 0.12]], peak: 0.4, a: 0.025, d: 0.45, s: 0.6, r: 0.16, lp: [5200, 1500] }
    ]
  };

  const trackProfiles = profiles[track.id] || profiles.flute;
  const patch = trackProfiles[presetIndex % trackProfiles.length];
  playSynthTone(bus, { f: freq, ...patch }, time, duration);
}

/* ==========================================================================
   3. Track Definitions & Sound Preset Dispatch
   ========================================================================== */
function buildNoteRange(lowMidi, highMidi) {
  const rows = [];
  for (let midi = highMidi; midi >= lowMidi; midi--) {
    const name = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    rows.push({
      id: `${name}${octave}`,
      label: `${name.replace('#', '♯')}${octave}`,
      isBlackKey: name.includes('#'),
    });
  }
  return rows;
}

const DRUM_ROWS = [
  ['crash', 'Crash'],
  ['ohat', 'Open hat'],
  ['hat', 'Hi-hat'],
  ['clap', 'Clap'],
  ['snare', 'Snare'],
  ['tom1', 'Tom 1'],
  ['tom2', 'Tom 2'],
  ['kick', 'Kick'],
].map(([id, label]) => ({ id, label }));

const ORCHESTRAL_TRACK_CONFIGS = [
  ['trumpet', 'Trumpet', 58, 82, '#ffb347', ['Bright trumpet', 'Muted trumpet', 'Jazz trumpet']],
  ['trombone', 'Trombone', 40, 64, '#e6a15c', ['Tenor trombone', 'Muted trombone', 'Brass section']],
  ['clarinet', 'Clarinet', 55, 79, '#66d6b3', ['Concert clarinet', 'Warm clarinet', 'Reed clarinet']],
  ['flute', 'Flute', 60, 84, '#7bdcff', ['Concert flute', 'Soft flute', 'Piccolo']],
  ['violin', 'Violin', 55, 79, '#f28ab2', ['Solo violin', 'Warm strings', 'Staccato violin']],
  ['cello', 'Cello', 36, 60, '#b69cff', ['Solo cello', 'Warm cello', 'Pizzicato cello']],
  ['saxophone', 'Saxophone', 48, 72, '#f3d36b', ['Alto sax', 'Tenor sax', 'Breathy sax']],
];

const TRACKS = [
  { id: 'drums', name: 'Drum kit', make: defaultDrumVoice, isDrum: true, vol: 85, rows: DRUM_ROWS },
  { id: 'piano', name: 'Digital piano', make: defaultPianoVoice, isDrum: false, vol: 80, rows: buildNoteRange(48, 72) },
  { id: 'guitar', name: 'Electric guitar', make: defaultGuitarVoice, isDrum: false, vol: 70, rows: buildNoteRange(40, 64) },
  { id: 'bass', name: 'Bass guitar', make: defaultBassVoice, isDrum: false, vol: 85, rows: buildNoteRange(28, 52) },
  ...ORCHESTRAL_TRACK_CONFIGS.map(([id, name, lowMidi, highMidi, color, sounds]) => {
    document.documentElement.style.setProperty(`--c-${id}`, color);
    return {
      id,
      name,
      vol: 72,
      rows: buildNoteRange(lowMidi, highMidi),
      sounds,
      orchestra: true,
      isDrum: false,
    };
  }),
];

const SOUND_PRESETS = {
  drums: ['Studio kit', '808 kit', 'Soft kit'],
  piano: ['Digital piano', 'Warm piano', 'Bell keys', 'Electric piano'],
  guitar: ['Electric guitar', 'Clean guitar', 'Muted pluck', 'Synth lead'],
  bass: ['Bass guitar', 'Deep sub', 'Picked bass', 'Synth bass'],
};

const CELL_WIDTH = 26;
let totalSteps = 32;

const getTrackById = (id) => TRACKS.find((track) => track.id === id);

const applyTrackGain = (track) => {
  track.bus.gain.value = track.mute ? 0 : track.vol / 100;
};

TRACKS.forEach((track) => {
  track.bus = audioCtx.createGain();
  track.bus.connect(sessionGain);
  track.mute = false;
  track.sound = 0;
  track.pattern = {};
  track.customBuffer = null;
  applyTrackGain(track);
});

/**
 * Trigger an instrument note or custom audio buffer using the track's selected sound preset.
 */
function playInstrument(track, bus, rowId, time, duration) {
  if (track.customBuffer) {
    playBuffer(bus, track.customBuffer, time, duration);
    return;
  }

  if (track.orchestra) {
    orchestraVoice(track, bus, rowId, time, duration);
    return;
  }

  if (track.id === 'drums') {
    if (track.sound === 1 && rowId === 'kick') {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100, time);
      osc.frequency.exponentialRampToValueAtTime(35, time + 0.35);
      gain.gain.setValueAtTime(1.2, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
      osc.connect(gain);
      gain.connect(bus);
      osc.start(time);
      osc.stop(time + 0.42);
    } else {
      track.make(bus, rowId, time);
    }
    return;
  }

  const freq = noteToHz(rowId);

  if (track.id === 'piano') {
    if (track.sound === 1) {
      playSynthTone(bus, { f: freq, osc: [['sine', 1, 0, 0.8], ['triangle', 2, -3, 0.2]], peak: 0.42, a: 0.012, d: 1.5, s: 0.08, r: 0.45, lp: [3000, 700] }, time, duration);
      return;
    }
    if (track.sound === 2) {
      playSynthTone(bus, { f: freq, osc: [['sine', 1, 0, 0.7], ['sine', 2, 0, 0.5], ['sine', 3, 0, 0.25]], peak: 0.4, a: 0.002, d: 1.2, s: 0.03, r: 0.18, lp: [7000, 1800] }, time, duration);
      return;
    }
    if (track.sound === 3) {
      playSynthTone(bus, { f: freq, osc: [['triangle', 1, 0, 0.7], ['sine', 2, 4, 0.35]], peak: 0.45, a: 0.008, d: 1.2, s: 0.12, r: 0.25, lp: [5000, 1200] }, time, duration);
      return;
    }
  }

  if (track.id === 'guitar') {
    if (track.sound === 1) {
      playSynthTone(bus, { f: freq, osc: [['triangle', 1, -4, 0.55], ['triangle', 1, 4, 0.55], ['sine', 2, 0, 0.08]], peak: 0.36, a: 0.008, d: 1.1, s: 0.14, r: 0.22, lp: [3600, 900] }, time, duration);
      return;
    }
    if (track.sound === 2) {
      playSynthTone(bus, { f: freq, osc: [['triangle', 1, 0, 0.7], ['sine', 2, 0, 0.12]], peak: 0.32, a: 0.003, d: 0.45, s: 0.05, r: 0.1, lp: [5000, 1300] }, time, duration);
      return;
    }
    if (track.sound === 3) {
      playSynthTone(bus, { f: freq, osc: [['sawtooth', 1, -8, 0.45], ['sawtooth', 1, 8, 0.45]], peak: 0.35, a: 0.02, d: 0.8, s: 0.22, r: 0.2, lp: [2500, 700] }, time, duration);
      return;
    }
  }

  if (track.id === 'bass') {
    if (track.sound === 1) {
      playSynthTone(bus, { f: freq, osc: [['sine', 1, 0, 1]], peak: 0.8, a: 0.01, d: 0.4, s: 0.5, r: 0.18, lp: [400, 120] }, time, duration);
      return;
    }
    if (track.sound === 2) {
      playSynthTone(bus, { f: freq, osc: [['triangle', 1, 0, 0.7], ['sawtooth', 1, 0, 0.3]], peak: 0.65, a: 0.003, d: 0.35, s: 0.28, r: 0.1, lp: [1300, 320] }, time, duration);
      return;
    }
    if (track.sound === 3) {
      playSynthTone(bus, { f: freq, osc: [['square', 1, 0, 0.35], ['sine', 0.5, 0, 0.8]], peak: 0.65, a: 0.015, d: 0.55, s: 0.35, r: 0.16, lp: [700, 180] }, time, duration);
      return;
    }
  }

  track.make(bus, rowId, time, duration);
}

/* ==========================================================================
   4. UI State & Channel Strips Sidebar
   ========================================================================== */
let selectedTrack = TRACKS[0];
let noteLength = 1;
let editorView = 'all'; // 'all' | 'single'
let hideUnusedRows = true;

let playheadEl = null;
let isDrawing = false;
let drawMode = 'add'; // 'add' | 'del'

function selectTrack(track) {
  selectedTrack = track;
  TRACKS.forEach((t) => t.stripEl.classList.toggle('selected', t === track));
  renderRoll();
}

function initChannelStrips() {
  const sidebar = $('#track-strips');

  TRACKS.forEach((track) => {
    const initialColor = getComputedStyle(document.documentElement)
      .getPropertyValue(`--c-${track.id}`)
      .trim();

    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.style.setProperty('--tc', `var(--c-${track.id})`);
    strip.innerHTML = `
      <div class="strip-header">
        <b>${track.name}</b>
        <input class="color-picker" type="color" value="${initialColor}" aria-label="${track.name} color">
        <button class="mute-btn" type="button" aria-pressed="false" title="Mute">M</button>
      </div>
      <input type="range" min="0" max="100" value="${track.vol}" aria-label="${track.name} volume">
      <small>Volume <span>${track.vol}</span></small>
      <select class="sound-picker" aria-label="${track.name} sound"></select>
    `;

    strip.addEventListener('click', () => selectTrack(track));

    const colorInput = strip.querySelector('.color-picker');
    colorInput.addEventListener('click', (e) => e.stopPropagation());
    colorInput.addEventListener('input', () => {
      document.documentElement.style.setProperty(`--c-${track.id}`, colorInput.value);
      renderRoll();
    });

    const muteBtn = strip.querySelector('.mute-btn');
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track.mute = !track.mute;
      muteBtn.setAttribute('aria-pressed', String(track.mute));
      applyTrackGain(track);
      renderRoll();
    });

    const volSlider = strip.querySelector('input[type="range"]');
    const volLabel = strip.querySelector('small span');
    volSlider.addEventListener('click', (e) => e.stopPropagation());
    volSlider.addEventListener('input', () => {
      track.vol = Number(volSlider.value);
      volLabel.textContent = volSlider.value;
      applyTrackGain(track);
    });

    const soundSelect = strip.querySelector('.sound-picker');
    soundSelect.addEventListener('click', (e) => e.stopPropagation());
    const soundOptions = track.sounds || SOUND_PRESETS[track.id];
    soundOptions.forEach((presetName, index) => {
      soundSelect.add(new Option(presetName, String(index)));
    });
    soundSelect.addEventListener('change', () => {
      track.sound = Number(soundSelect.value);
    });

    track.stripEl = strip;
    sidebar.appendChild(strip);
  });

  $('#master-volume').addEventListener('input', (e) => {
    masterGain.gain.value = Number(e.target.value) / 100;
  });
}

/* ==========================================================================
   5. Piano Roll Editor & Pointer Interaction
   ========================================================================== */
function auditionNote(track, rowId) {
  if (isPaused) return;
  audioCtx.resume();
  playInstrument(track, track.bus, rowId, audioCtx.currentTime + 0.01, 0.3);
}

function renderRoll() {
  const isSingleTrack = editorView !== 'all';
  const visibleTracks = isSingleTrack ? [selectedTrack] : TRACKS;
  const header = $('#editor-header');
  const roll = $('#piano-roll');

  header.style.setProperty('--tc', `var(--c-${selectedTrack.id})`);
  header.innerHTML = `
    <button class="tab" id="tab-single" type="button" aria-pressed="${isSingleTrack}">Track editor</button>
    <button class="tab" id="tab-all" type="button" aria-pressed="${!isSingleTrack}">All tracks</button>
    ${
      isSingleTrack
        ? `<span class="track-dot"></span><h2>${selectedTrack.name}</h2>`
        : `<label class="control-label"><input type="checkbox" id="chk-hide-unused" ${hideUnusedRows ? 'checked' : ''}> Hide empty rows</label>`
    }
    <label class="control-label">
      Note length
      <select id="note-length-select">
        <option value="1">1/16</option>
        <option value="2">1/8</option>
        <option value="4">1/4</option>
        <option value="8">1/2</option>
        <option value="16">1 bar</option>
        <option value="1.333333">1/8 triplet</option>
        <option value="2.666667">1/4 triplet</option>
        <option value="5.333333">1/2 triplet</option>
        <option value="10.666667">1 bar triplet</option>
      </select>
    </label>
    <button id="btn-clear-pattern" type="button">${isSingleTrack ? 'Clear track' : 'Clear all'}</button>
  `;

  $('#tab-single').addEventListener('click', () => {
    editorView = 'single';
    renderRoll();
  });

  $('#tab-all').addEventListener('click', () => {
    editorView = 'all';
    renderRoll();
  });

  if (!isSingleTrack) {
    $('#chk-hide-unused').addEventListener('change', (e) => {
      hideUnusedRows = e.target.checked;
      renderRoll();
    });
  }

  const lengthSelect = $('#note-length-select');
  lengthSelect.value = String(noteLength);
  lengthSelect.addEventListener('change', (e) => {
    noteLength = Number(e.target.value);
  });

  $('#btn-clear-pattern').addEventListener('click', () => {
    visibleTracks.forEach((track) => {
      track.pattern = {};
    });
    renderRoll();
  });

  // Build Timeline Ruler
  let html = '<div class="ruler"><div class="ruler-corner"></div>';
  for (let step = 0; step < totalSteps; step++) {
    const isBarStart = step % 16 === 0;
    const isBeatStart = step % 4 === 0;
    const label = isBarStart
      ? `${step / 16 + 1}`
      : isBeatStart
        ? `${Math.floor(step / 16) + 1}.${(step % 16) / 4 + 1}`
        : '';

    const classes = ['ruler-cell'];
    if (isBarStart) classes.push('bar-start');
    else if (!isBeatStart) classes.push('sub-beat');

    html += `<div class="${classes.join(' ')}">${label}</div>`;
  }
  html += '</div>';

  // Build Track Sections & Grid Cells
  visibleTracks.forEach((track) => {
    const rows =
      !isSingleTrack && hideUnusedRows
        ? track.rows.filter((row) =>
            Object.keys(track.pattern).some((key) => key.startsWith(`${row.id}|`))
          )
        : track.rows;

    const cellHeight = isSingleTrack
      ? track.isDrum ? 30 : 20
      : track.isDrum ? 16 : 14;

    html += `<div class="track-section" style="--tc: var(--c-${track.id}); --ch: ${cellHeight}px">`;

    if (!isSingleTrack) {
      html += `<div class="track-banner"><span>${track.name}${track.mute ? ' (muted)' : ''}</span></div>`;
    }

    rows.forEach((row) => {
      html += `<div class="roll-row">`;
      html += `<div class="row-label ${row.isBlackKey ? 'black-key' : ''}" data-t="${track.id}" data-r="${row.id}">${row.label}</div>`;

      for (let step = 0; step < totalSteps; step++) {
        const noteSpan = track.pattern[`${row.id}|${step}`];
        const cellClasses = ['grid-cell'];
        if ((step >> 2) & 1) cellClasses.push('alt-beat');
        if (step % 16 === 0) cellClasses.push('bar-line');
        else if (step % 4 === 0) cellClasses.push('beat-line');

        html += `<div class="${cellClasses.join(' ')}" data-t="${track.id}" data-r="${row.id}" data-s="${step}">${
          noteSpan ? `<i class="note-block" style="--n: ${noteSpan}"></i>` : ''
        }</div>`;
      }

      html += '</div>';
    });

    html += '</div>';
  });

  roll.innerHTML = `${html}<div id="playhead"></div>`;
  playheadEl = $('#playhead');
}

function toggleGridCell(cellEl) {
  const track = getTrackById(cellEl.dataset.t);
  const key = `${cellEl.dataset.r}|${cellEl.dataset.s}`;

  if (drawMode === 'add' && !track.pattern[key]) {
    const span = track.isDrum ? 1 : noteLength;
    track.pattern[key] = span;
    cellEl.innerHTML = `<i class="note-block" style="--n: ${span}"></i>`;
    auditionNote(track, cellEl.dataset.r);
  } else if (drawMode === 'del' && track.pattern[key]) {
    delete track.pattern[key];
    cellEl.innerHTML = '';
  }
}

function initPianoRollEvents() {
  const roll = $('#piano-roll');

  roll.addEventListener('pointerdown', (e) => {
    const labelEl = e.target.closest('.row-label');
    if (labelEl) {
      auditionNote(getTrackById(labelEl.dataset.t), labelEl.dataset.r);
      return;
    }

    const cellEl = e.target.closest('.grid-cell');
    if (!cellEl) return;

    e.preventDefault();
    isDrawing = true;
    const track = getTrackById(cellEl.dataset.t);
    const key = `${cellEl.dataset.r}|${cellEl.dataset.s}`;
    drawMode = track.pattern[key] ? 'del' : 'add';
    toggleGridCell(cellEl);
  });

  roll.addEventListener('pointerover', (e) => {
    if (!isDrawing || e.buttons !== 1) return;
    const cellEl = e.target.closest('.grid-cell');
    if (cellEl) toggleGridCell(cellEl);
  });

  window.addEventListener('pointerup', () => {
    isDrawing = false;
  });
}

/* ==========================================================================
   6. Built-in Genre Presets
   ========================================================================== */
const everyNthStep = (interval, offset = 0) =>
  Array.from({ length: 32 }, (_, i) => i).filter((i) => i % interval === offset);

function placeNotes(trackId, rowIds, steps, duration = 1) {
  const track = getTrackById(trackId);
  [].concat(rowIds).forEach((rowId) => {
    steps.forEach((step) => {
      track.pattern[`${rowId}|${step}`] = duration;
    });
  });
}

const GENRE_PRESETS = {
  Rock: {
    bpm: 120,
    build() {
      placeNotes('drums', 'kick', [0, 8, 10, 16, 24, 26]);
      placeNotes('drums', 'snare', [4, 12, 20, 28]);
      placeNotes('drums', 'hat', everyNthStep(2));
      placeNotes('drums', 'crash', [0]);

      placeNotes('bass', 'E1', everyNthStep(2).filter((i) => i < 16), 2);
      placeNotes('bass', 'A1', [16, 18, 20, 22], 2);
      placeNotes('bass', 'B1', [24, 26, 28, 30], 2);

      placeNotes('guitar', ['E2', 'B2', 'E3'], [0, 6, 8, 12], 2);
      placeNotes('guitar', ['A2', 'E3', 'A3'], [16, 22, 24], 2);
      placeNotes('guitar', ['B2', 'F#3', 'B3'], [28], 4);

      placeNotes('piano', ['E3', 'B3'], [0], 16);
      placeNotes('piano', ['A3', 'E4'], [16], 12);
      placeNotes('piano', ['B3', 'F#4'], [28], 4);
    },
  },
  'Hip-hop': {
    bpm: 90,
    build() {
      placeNotes('drums', 'kick', [0, 7, 10, 16, 18, 26]);
      placeNotes('drums', 'snare', [8, 24]);
      placeNotes('drums', 'clap', [8, 24]);
      placeNotes('drums', 'hat', everyNthStep(2));
      placeNotes('drums', 'ohat', [14]);

      placeNotes('bass', 'E1', [0], 6);
      placeNotes('bass', 'E1', [10], 4);
      placeNotes('bass', 'G1', [16], 6);
      placeNotes('bass', 'D2', [26], 4);

      placeNotes('piano', ['E3', 'G3', 'B3'], [0, 10], 4);
      placeNotes('piano', ['D3', 'F#3', 'A3'], [16, 26], 4);

      placeNotes('guitar', 'E3', [12], 2);
      placeNotes('guitar', 'G3', [22], 2);
      placeNotes('guitar', 'B3', [30], 2);
    },
  },
  House: {
    bpm: 124,
    build() {
      placeNotes('drums', 'kick', everyNthStep(4));
      placeNotes('drums', 'clap', [4, 12, 20, 28]);
      placeNotes('drums', 'ohat', everyNthStep(4, 2));
      placeNotes('drums', 'hat', everyNthStep(4, 3));

      placeNotes('bass', 'A1', [2, 6, 10, 14], 2);
      placeNotes('bass', 'F1', [18, 22, 26, 30], 2);

      placeNotes('piano', ['A3', 'C4', 'E4'], [0, 3, 6, 10]);
      placeNotes('piano', ['F3', 'A3', 'C4'], [16, 19, 22, 26]);

      placeNotes('guitar', 'A3', [7, 15, 23, 31]);
    },
  },
  Funk: {
    bpm: 105,
    build() {
      placeNotes('drums', 'kick', [0, 3, 10, 16, 19, 26]);
      placeNotes('drums', 'snare', [4, 12, 20, 28]);
      placeNotes('drums', 'hat', everyNthStep(1));
      placeNotes('drums', 'ohat', [14, 30]);

      placeNotes('bass', 'E1', [0, 3, 16, 19], 2);
      placeNotes('bass', 'G1', [6, 22]);
      placeNotes('bass', 'A1', [8, 24], 2);
      placeNotes('bass', 'E2', [10]);
      placeNotes('bass', 'D2', [14, 30]);
      placeNotes('bass', 'B1', [26]);

      placeNotes('guitar', ['E3', 'G#3', 'D4'], [2, 5, 7, 10, 13, 15, 18, 21, 23, 26, 29, 31]);
      placeNotes('piano', ['E3', 'G3', 'B3', 'D4'], [0, 6, 16, 22], 3);
    },
  },
  Reggae: {
    bpm: 76,
    build() {
      placeNotes('drums', 'kick', [8, 24]);
      placeNotes('drums', 'snare', [8, 24]);
      placeNotes('drums', 'hat', everyNthStep(2));

      placeNotes('bass', 'A1', [0], 6);
      placeNotes('bass', 'C2', [8], 4);
      placeNotes('bass', 'D2', [12], 4);
      placeNotes('bass', 'G1', [16], 6);
      placeNotes('bass', 'B1', [24], 4);
      placeNotes('bass', 'D2', [28], 4);

      placeNotes('guitar', ['A2', 'E3', 'A3'], [2, 6, 10, 14]);
      placeNotes('guitar', ['D3', 'A3', 'D4'], [18, 22, 26, 30]);

      placeNotes('piano', ['A3', 'C4'], [0, 4, 8, 12]);
      placeNotes('piano', ['D4', 'F4'], [16, 20, 24, 28]);
    },
  },
  'Pop ballad': {
    bpm: 70,
    build() {
      placeNotes('drums', 'kick', [0, 10, 16]);
      placeNotes('drums', 'snare', [8, 24]);
      placeNotes('drums', 'hat', everyNthStep(4));

      placeNotes('bass', 'C2', [0, 8], 8);
      placeNotes('bass', 'G1', [16, 24], 8);

      placeNotes('piano', 'C3', [0], 4);
      placeNotes('piano', 'G3', [2, 10, 14], 2);
      placeNotes('piano', 'C4', [4, 8, 12], 2);
      placeNotes('piano', 'E4', [6], 2);
      placeNotes('piano', 'D3', [16], 4);
      placeNotes('piano', 'G3', [18, 26, 30], 2);
      placeNotes('piano', 'B3', [20, 24, 28], 2);
      placeNotes('piano', 'D4', [22], 2);

      placeNotes('guitar', ['C3', 'E3', 'G3', 'C4'], [0], 16);
      placeNotes('guitar', ['B2', 'D3', 'G3', 'B3'], [16], 16);
    },
  },
  'Blank canvas': {
    bpm: 100,
    build() {},
  },
};

function loadGenre(genreName) {
  TRACKS.forEach((track) => {
    track.pattern = {};
  });
  const preset = GENRE_PRESETS[genreName];
  preset.build();
  $('#bpm-input').value = preset.bpm;
  renderRoll();
}

function initGenreSelector() {
  const select = $('#genre-select');
  Object.keys(GENRE_PRESETS).forEach((name) => select.add(new Option(name)));
  select.addEventListener('change', () => loadGenre(select.value));
}

/* ==========================================================================
   7. Audio Upload & Approximate Band-Pass Stem Extraction
   ========================================================================== */
let uploadedAudioBuffer = null;

function extractStem(trackId) {
  const statusEl = $('#audio-status');
  if (!uploadedAudioBuffer) {
    statusEl.textContent = 'Choose an MP3/WAV file first.';
    return;
  }

  const sampleRate = uploadedAudioBuffer.sampleRate;
  const numChannels = uploadedAudioBuffer.numberOfChannels;
  const length = uploadedAudioBuffer.length;
  const outputBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);

  const lowCut = trackId === 'drums' ? 35 : trackId === 'piano' ? 180 : 500;
  const highCut = trackId === 'drums' ? 180 : trackId === 'piano' ? 3500 : 6500;

  const alphaLow = 1 - Math.exp((-2 * Math.PI * highCut) / sampleRate);
  const alphaHigh = 1 - Math.exp((-2 * Math.PI * lowCut) / sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const src = uploadedAudioBuffer.getChannelData(ch);
    const dst = outputBuffer.getChannelData(ch);
    let lowState = 0;
    let highState = 0;
    let prevSample = 0;

    for (let i = 0; i < length; i++) {
      lowState += alphaLow * (src[i] - lowState);
      highState += alphaHigh * (src[i] - highState);
      const bandPassed = lowState - highState;

      if (trackId === 'drums') {
        const transient = Math.abs(src[i] - prevSample);
        dst[i] = bandPassed * Math.min(1, transient * 18 + 0.12);
        prevSample = src[i];
      } else {
        dst[i] = bandPassed;
      }
    }
  }

  const track = getTrackById(trackId);
  track.customBuffer = outputBuffer;

  const chip = document.createElement('span');
  chip.className = 'custom-sound';
  chip.style.setProperty('--tc', `var(--c-${trackId})`);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.textContent = `▶ ${trackId} stem`;
  previewBtn.addEventListener('click', () => playBuffer(masterGain, outputBuffer));

  const assignBtn = document.createElement('button');
  assignBtn.type = 'button';
  assignBtn.textContent = `Use on ${track.name}`;
  assignBtn.addEventListener('click', () => {
    track.customBuffer = outputBuffer;
    statusEl.textContent = `${trackId} stem assigned to ${track.name}`;
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove custom sound';
  removeBtn.addEventListener('click', () => {
    chip.remove();
    if (track.customBuffer === outputBuffer) {
      track.customBuffer = null;
    }
  });

  chip.append(previewBtn, assignBtn, removeBtn);
  $('#custom-sounds-list').appendChild(chip);

  statusEl.textContent = `Created approximate ${trackId} stem (${outputBuffer.duration.toFixed(1)}s). Not AI source separation.`;
}

function initAudioLab() {
  const fileInput = $('#audio-file-input');
  const statusEl = $('#audio-status');
  const extractBtnIds = ['btn-extract-drums', 'btn-extract-piano', 'btn-extract-guitar'];

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      uploadedAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      statusEl.textContent = `Loaded ${file.name} · ${uploadedAudioBuffer.duration.toFixed(1)}s`;
      extractBtnIds.forEach((id) => {
        $(`#${id}`).disabled = false;
      });
    } catch {
      statusEl.textContent = 'Could not decode file. Try a standard MP3 or WAV.';
    }
  });

  $('#btn-extract-drums').addEventListener('click', () => extractStem('drums'));
  $('#btn-extract-piano').addEventListener('click', () => extractStem('piano'));
  $('#btn-extract-guitar').addEventListener('click', () => extractStem('guitar'));
}

/* ==========================================================================
   8. Transport Controls & Lookahead Audio Scheduler
   ========================================================================== */
let isPlaying = false;
let isPaused = false;
let isEnding = false;
let isLooping = true;

let endTime = 0;
let currentScheduleStep = 0;
let nextNoteTime = 0;
let visualStepQueue = [];
let schedulerTimer = null;
let displayStep = 0;

const getStepDuration = () => 60 / (Number($('#bpm-input').value) || 100) / 4;

function scheduleStep(stepIndex, time) {
  TRACKS.forEach((track) => {
    if (track.mute) return;
    for (const row of track.rows) {
      const span = track.pattern[`${row.id}|${stepIndex}`];
      if (span) {
        const duration = Math.max(0.05, span * getStepDuration() * 0.95);
        playInstrument(track, track.bus, row.id, time, duration);
      }
    }
  });
}

function runSchedulerTick() {
  if (isEnding) return;

  while (nextNoteTime < audioCtx.currentTime + 0.12) {
    scheduleStep(currentScheduleStep, nextNoteTime);
    visualStepQueue.push({ step: currentScheduleStep, time: nextNoteTime });
    nextNoteTime += getStepDuration();
    currentScheduleStep++;

    if (currentScheduleStep >= totalSteps) {
      if (isLooping) {
        currentScheduleStep = 0;
      } else {
        isEnding = true;
        endTime = nextNoteTime;
        break;
      }
    }
  }
}

function updateTransportUI() {
  const btnPlay = $('#btn-play');
  const btnPause = $('#btn-pause');
  const btnStop = $('#btn-stop');

  btnPlay.classList.toggle('active', isPlaying && !isPaused);
  btnPlay.disabled = isPlaying;

  btnPause.disabled = !isPlaying;
  btnPause.classList.toggle('active', isPaused);
  btnPause.textContent = isPaused ? '▶ Resume' : '❚❚ Pause';

  btnStop.disabled = !isPlaying;
}

function startPlayback() {
  if (isPlaying) return;
  audioCtx.resume();

  isPlaying = true;
  isPaused = false;
  isEnding = false;
  currentScheduleStep = 0;
  displayStep = 0;
  visualStepQueue = [];
  nextNoteTime = audioCtx.currentTime + 0.08;

  runSchedulerTick();
  schedulerTimer = setInterval(runSchedulerTick, 25);
  updateTransportUI();
}

function togglePause() {
  if (!isPlaying) return;
  if (isPaused) {
    isPaused = false;
    audioCtx.resume();
  } else {
    isPaused = true;
    audioCtx.suspend();
  }
  updateTransportUI();
}

function stopPlayback() {
  if (!isPlaying) return;
  clearInterval(schedulerTimer);

  isPlaying = false;
  isPaused = false;
  isEnding = false;
  visualStepQueue = [];
  currentScheduleStep = 0;
  displayStep = 0;

  // Fade out active voices smoothly and swap in a fresh session gain bus
  audioCtx.resume();
  const retiringSession = sessionGain;
  retiringSession.gain.setTargetAtTime(0, audioCtx.currentTime, 0.015);
  setTimeout(() => retiringSession.disconnect(), 200);

  sessionGain = audioCtx.createGain();
  sessionGain.connect(masterGain);
  TRACKS.forEach((track) => {
    track.bus.disconnect();
    track.bus.connect(sessionGain);
  });

  if (playheadEl) playheadEl.style.display = 'none';
  $('#lcd-display').textContent = '1 . 1 . 1';
  updateTransportUI();
}

function startPlayheadAnimationLoop() {
  function animate() {
    if (isPlaying) {
      const now = audioCtx.currentTime;
      while (visualStepQueue.length > 1 && visualStepQueue[1].time <= now) {
        visualStepQueue.shift();
      }
      if (visualStepQueue[0] && visualStepQueue[0].time <= now) {
        displayStep = visualStepQueue[0].step;
      }

      if (isEnding && now >= endTime) {
        stopPlayback();
      } else {
        if (playheadEl) {
          playheadEl.style.display = 'block';
          playheadEl.style.transform = `translateX(${displayStep * CELL_WIDTH}px)`;
        }
        const bar = (displayStep >> 4) + 1;
        const beat = ((displayStep % 16) >> 2) + 1;
        const sixteenth = (displayStep % 4) + 1;
        $('#lcd-display').textContent = `${bar} . ${beat} . ${sixteenth}`;
      }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

function initTransport() {
  $('#bars-select').addEventListener('change', (e) => {
    totalSteps = Number(e.target.value) * 16;
    renderRoll();
  });

  $('#btn-play').addEventListener('click', startPlayback);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-stop').addEventListener('click', stopPlayback);

  $('#btn-loop').addEventListener('click', (e) => {
    isLooping = !isLooping;
    e.currentTarget.setAttribute('aria-pressed', String(isLooping));
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.closest('input, select, button, textarea')) return;
    e.preventDefault();
    isPlaying ? togglePause() : startPlayback();
  });
}

/* ==========================================================================
   9. Application Initialization
   ========================================================================== */
function init() {
  initChannelStrips();
  initPianoRollEvents();
  initGenreSelector();
  initAudioLab();
  initTransport();

  selectTrack(TRACKS[0]);
  loadGenre('Rock');
  updateTransportUI();
  startPlayheadAnimationLoop();
}

init();
