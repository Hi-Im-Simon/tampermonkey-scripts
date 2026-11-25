// ==UserScript==
// @name         Session Timer
// @namespace    session-timer
// @version      2.11.0
// @description  A draggable session timer with saved time limits, configurable reminders and end alerts.
// @match        https://config.example.invalid/*
// @grant        GM.getTab
// @grant        GM.saveTab
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  if (window.__sessionTimerLoaded) {
    return;
  }

  window.__sessionTimerLoaded = true;

  // =========================
  // Configuration
  // =========================

  const DEFAULT_TARGET_MINUTES = 15;
  const TARGET_PRESETS = [5, 7, 10, 12, DEFAULT_TARGET_MINUTES, 20, 30, 60];
  const PREFERENCES_KEY = "session-timer.preferences";
  const CUSTOM_SOUND_PREFIX = "session-timer.custom-sound.";
  const TAB_TIMER_KEY = "session-timer.session";
  // Add the actual sites in Tampermonkey > Settings > User matches.
  // Open a matched page once to create this entry in Tampermonkey > Storage.
  // For a shared origin, set startupPath to a distinct path pattern (e.g. "/start*").
  const CONFIG_KEY = "timerConfig";

  const DEFAULT_ALERT_TIMING = {
    reminderEnabled: true,
    reminderStart: 2 / 3,
    reminderSeconds: 30,
    nearEndEnabled: true,
    nearEndStart: 29 / 30,
    nearEndSeconds: 10,
    endSeconds: 5,
    endGiveUpSeconds: 0,
  };
  const DEFAULT_ALERT_VOLUMES = { reminder: 50, nearEnd: 65, end: 100 };
  const DEFAULT_ALERT_SOUND = "classic";
  const ALERT_SOUNDS = {
    classic: {
      label: "Classic",
      waveform: "triangle",
      pitch: 1,
      level: 1,
      length: 1,
      attack: 0.015,
    },
    soft: {
      label: "Soft",
      waveform: "sine",
      pitch: 0.88,
      level: 0.8,
      length: 1.15,
      attack: 0.045,
    },
    bell: {
      label: "Bell",
      waveform: "custom",
      pitch: 1.4,
      level: 0.8,
      length: 1.3,
      attack: 0.006,
    },
    digital: {
      label: "Digital",
      waveform: "square",
      pitch: 1.1,
      level: 0.48,
      length: 0.65,
      attack: 0.008,
    },
    low: {
      label: "Low tone",
      waveform: "triangle",
      pitch: 0.65,
      level: 1,
      length: 1,
      attack: 0.02,
    },
  };
  const PREFERENCE_NAMES = [
    "preset",
    "custom",
    "collapsed",
    "position",
    ...Object.keys(DEFAULT_ALERT_TIMING),
    ...Object.keys(DEFAULT_ALERT_VOLUMES).flatMap((group) => [
      `${group}Volume`,
      `${group}Sound`,
    ]),
  ];
  const AUDIO_CLOCK_DRIFT_MS = 1000;
  const AUDIO_START_DELAY_SECONDS = 0.015;
  const AUDIO_REMINDER_HORIZON_MS = 180_000;
  const UI_REFRESH_INTERVAL_MS = 200;

  // Each note is [offset in seconds, frequency in hertz, duration in seconds].
  const CHIMES = {
    reminder: { level: 0.18, notes: [[0, 660, 0.22]] },
    nearEnd: {
      level: 0.24,
      notes: [
        [0, 660, 0.2],
        [0.17, 880, 0.26],
      ],
    },
    end: {
      level: 0.34,
      notes: [
        [0, 740, 0.2],
        [0.16, 990, 0.22],
        [0.33, 1175, 0.32],
      ],
    },
  };

  // =========================
  // State
  // =========================

  const pageEnteredAt = Date.now();
  const timerConfig = readTimerConfig();
  const timerPage = getTimerPage(timerConfig);
  if (timerPage === null) {
    return;
  }
  const startupMarkerRequired =
    timerPage === "startup" && timerConfig.readySelector !== "";
  let waitingForStartup = startupMarkerRequired;
  let invalidStartupSelector = false;
  let timerStartTimestamp = waitingForStartup ? null : pageEnteredAt;
  let timerTab = null;
  let targetMinutes = DEFAULT_TARGET_MINUTES;
  let selectedPreset = String(DEFAULT_TARGET_MINUTES);
  let customMinutes = String(DEFAULT_TARGET_MINUTES);
  let customCommitTimeout = null;
  let isCollapsed = false;
  let panelPosition = null;
  let dragPosition = null;

  let audioContext = null;
  let bellWave = null;
  let isAudioUnlocked = false;
  let hasUnlockedAudio = false;
  let isMuted = false;

  const alertVolumes = { ...DEFAULT_ALERT_VOLUMES };
  const alertSounds = {
    reminder: DEFAULT_ALERT_SOUND,
    nearEnd: DEFAULT_ALERT_SOUND,
    end: DEFAULT_ALERT_SOUND,
  };
  const customSounds = new Map();
  const alertTiming = { ...DEFAULT_ALERT_TIMING };
  let lastHandledCueAt = -1;
  let alertSchedule = null;
  let audioOutputs = null;
  const scheduledSounds = new Map();
  const previewSounds = new Map();
  let previewRequest = null;

  let overlay = null;

  let elapsedElement = null;
  let targetElement = null;
  let remainingElement = null;
  let customRow = null;
  let customInput = null;
  let muteButton = null;
  let collapseButton = null;
  let settingsButton = null;
  let bodyPanel = null;
  let detailsPanel = null;
  let alertSettings = null;
  let customSoundLibrary = null;
  let progressFill = null;

  // =========================
  // DOM helpers
  // =========================

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);

    if (options.id) {
      element.id = options.id;
    }

    if (options.className) {
      element.className = options.className;
    }

    if (options.text !== undefined) {
      element.textContent = options.text;
    }

    if (options.type) {
      element.type = options.type;
    }

    return element;
  }

  function appendChildren(parent, ...children) {
    parent.append(...children);
    return parent;
  }

  // =========================
  // General helpers
  // =========================

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function getElapsedMs() {
    return waitingForStartup ? 0 : Date.now() - timerStartTimestamp;
  }

  function getTimerPage(config) {
    if (!config) {
      return null;
    }
    const { origin, pathname, search } = location;
    if (origin === config.startupOrigin && origin !== config.workOrigin) {
      return "startup";
    }
    if (origin !== config.workOrigin) {
      return null;
    }
    if (origin === config.startupOrigin && config.startupPath) {
      const regex = config.startupPath
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      if (new RegExp(`^${regex}$`).test(pathname + search)) {
        return "startup";
      }
    }
    return "target";
  }

  function getTargetMs() {
    return targetMinutes * 60 * 1000;
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.floor(Math.abs(milliseconds) / 1000);

    const hours = Math.floor(totalSeconds / 3600);

    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(seconds).padStart(2, "0"),
      ].join(":");
    }

    return [
      String(Math.floor(totalSeconds / 60)).padStart(2, "0"),
      String(seconds).padStart(2, "0"),
    ].join(":");
  }

  // =========================
  // Timer and alerts
  // =========================

  function resetTimer() {
    clearAlertSchedule();
    stopPreview();
    timerStartTimestamp = waitingForStartup ? null : Date.now();
    lastHandledCueAt = -1;
    void saveTimerSession();
    scheduleAlerts();
    render();
  }

  function setTargetMinutes(minutes) {
    if (targetMinutes === minutes) {
      return;
    }

    const elapsed = getElapsedMs();
    const wasWithinLimit = elapsed < getTargetMs();
    targetMinutes = minutes;

    // Editing the limit skips warnings already in the past. Crossing
    // the new limit is the exception and warrants an immediate chime.
    lastHandledCueAt =
      wasWithinLimit && elapsed >= getTargetMs() ? -1 : elapsed;
    clearAlertSchedule();
    scheduleAlerts();
    render();
    updateAlertPreview();
  }

  function createCueSeries(sound, first, interval, end = Infinity) {
    let lastIndex = -1;
    if (first < end) {
      lastIndex = 0;
      if (interval > 0) {
        lastIndex = Math.ceil((end - first) / interval) - 1;
        if (Number.isFinite(end) && first + lastIndex * interval >= end) {
          lastIndex--;
        }
      }
    }
    const series = { sound, first, interval, end, lastIndex };
    series.nextIndex = lastCueIndexAt(series, lastHandledCueAt) + 1;
    return series;
  }

  function lastCueIndexAt(series, elapsed) {
    if (elapsed < series.first || series.lastIndex < 0) {
      return -1;
    }
    if (series.lastIndex === 0) {
      return 0;
    }
    return Math.min(
      series.lastIndex,
      Math.floor((elapsed - series.first) / series.interval),
    );
  }

  function cueTime(series, index) {
    return series.first + index * series.interval;
  }

  function getReminderStartTime(target, enabled, threshold) {
    return enabled ? target * threshold : target;
  }

  function getEndAlertCutoff(target, seconds) {
    return seconds === 0 ? Infinity : target + seconds * 1000;
  }

  function scheduleAlerts() {
    if (
      waitingForStartup ||
      !isAudioUnlocked ||
      audioContext.state !== "running"
    ) {
      return;
    }

    const elapsed = getElapsedMs();
    const offset = elapsed - audioContext.currentTime * 1000;
    if (
      alertSchedule &&
      Math.abs(offset - alertSchedule.offset) > AUDIO_CLOCK_DRIFT_MS
    ) {
      rememberPlayedCues();
      clearAlertSchedule();
    }

    const target = getTargetMs();
    const {
      reminderEnabled,
      reminderStart,
      reminderSeconds,
      nearEndEnabled,
      nearEndStart,
      nearEndSeconds,
      endSeconds,
      endGiveUpSeconds,
    } = alertTiming;
    const reminderAt = getReminderStartTime(
      target,
      reminderEnabled,
      reminderStart,
    );
    const nearEndAt = getReminderStartTime(
      target,
      nearEndEnabled,
      nearEndStart,
    );
    alertSchedule ??= {
      offset,
      reminder: createCueSeries(
        "reminder",
        reminderAt,
        reminderSeconds * 1000,
        nearEndAt,
      ),
      nearEnd: createCueSeries(
        "nearEnd",
        nearEndAt,
        nearEndSeconds * 1000,
        target,
      ),
      end: createCueSeries(
        "end",
        target,
        endSeconds * 1000,
        getEndAlertCutoff(target, endGiveUpSeconds),
      ),
    };
    const { reminder, nearEnd, end } = alertSchedule;
    const active =
      elapsed >= target ? end : elapsed >= nearEnd.first ? nearEnd : reminder;
    const dueIndex = lastCueIndexAt(active, elapsed);

    // When audio resumes, play the latest due cue only.
    if (
      elapsed < active.end &&
      dueIndex >= active.nextIndex &&
      isAlertSoundReady(active.sound)
    ) {
      queueAlert(active, dueIndex);
      lastHandledCueAt = cueTime(active, dueIndex);
      active.nextIndex = dueIndex + 1;
    }

    // Keep a bounded queue while scheduling the end signal in advance,
    // even when the first reminder is still far away.
    queueUpcoming(reminder, elapsed);
    queueUpcoming(nearEnd, elapsed);
    queueUpcoming(end, elapsed);
  }

  function queueUpcoming(series, elapsed) {
    if (!isAlertSoundReady(series.sound)) {
      return;
    }
    const firstFuture = lastCueIndexAt(series, elapsed) + 1;
    series.nextIndex = Math.max(series.nextIndex, firstFuture);

    const horizon = Math.max(series.first, elapsed) + AUDIO_REMINDER_HORIZON_MS;
    const lastUpcoming = Math.min(
      series.lastIndex,
      Math.max(firstFuture, lastCueIndexAt(series, horizon)),
    );
    while (series.nextIndex <= lastUpcoming) {
      queueAlert(series, series.nextIndex);
      series.nextIndex++;
    }
  }

  function rememberPlayedCues() {
    if (!alertSchedule) {
      return;
    }

    const elapsed = alertSchedule.offset + audioContext.currentTime * 1000;
    for (const series of [
      alertSchedule.reminder,
      alertSchedule.nearEnd,
      alertSchedule.end,
    ]) {
      const index = Math.min(
        series.nextIndex - 1,
        lastCueIndexAt(series, elapsed),
      );
      if (index >= 0) {
        lastHandledCueAt = Math.max(lastHandledCueAt, cueTime(series, index));
      }
    }
  }

  function queueAlert(series, index) {
    const group = series.sound;
    const start = Math.max(
      audioContext.currentTime + AUDIO_START_DELAY_SECONDS,
      (cueTime(series, index) - alertSchedule.offset) / 1000,
    );
    let cutoff = group === "end" ? series.end : Infinity;
    if (customSounds.get(alertSounds[group])?.buffer) {
      // A long clip should give way to the next repeat or alert group.
      cutoff = index < series.lastIndex ? cueTime(series, index + 1) : series.end;
    }
    playAlertSound(
      group,
      start,
      audioOutputs[group],
      scheduledSounds,
      1,
      (cutoff - alertSchedule.offset) / 1000,
    );
  }

  function clearAlertSchedule() {
    stopSounds(scheduledSounds);
    alertSchedule = null;
  }

  // =========================
  // Audio
  // =========================

  async function decodeCustomSound(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    const Decoder =
      window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new Decoder(1, 1, 44100).decodeAudioData(bytes.buffer);
  }

  function isAlertSoundReady(group) {
    const sound = customSounds.get(alertSounds[group]);
    return !sound || sound.buffer !== undefined;
  }

  function loadCustomSound(id) {
    const sound = customSounds.get(id);
    if (sound && sound.buffer === undefined) {
      sound.loading ??= Promise.resolve().then(async () => {
        try {
          sound.buffer = await decodeCustomSound(GM_getValue(id)?.data);
        } catch (error) {
          sound.buffer = null;
          console.warn("[Session Timer] Could not load custom sound:", error);
        }
        scheduleAlerts();
      });
      return sound.loading;
    }
  }

  function updateAudioState() {
    const unlocked = audioContext?.state === "running";
    if (unlocked === isAudioUnlocked) {
      return;
    }
    isAudioUnlocked = unlocked;
    if (unlocked) {
      hasUnlockedAudio = true;
      scheduleAlerts();
    } else {
      rememberPlayedCues();
      clearAlertSchedule();
      stopPreview();
    }
    updateAudioButton();
  }

  function updateOutputVolumes() {
    if (!audioOutputs) {
      return;
    }
    const now = audioContext.currentTime;
    for (const [group, output] of Object.entries(audioOutputs)) {
      output.gain.setValueAtTime(isMuted ? 0 : alertVolumes[group] / 100, now);
    }
  }

  async function unlockAudio() {
    const AudioContextConstructor =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      return false;
    }
    try {
      if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContextConstructor();
        bellWave = null;
        audioOutputs = {};
        for (const group of Object.keys(alertVolumes)) {
          const output = audioContext.createGain();
          output.connect(audioContext.destination);
          audioOutputs[group] = output;
        }
        updateOutputVolumes();
        audioContext.addEventListener("statechange", updateAudioState);
      }
      if (audioContext.state !== "running") {
        await audioContext.resume();
      }
      updateAudioState();
      return isAudioUnlocked;
    } catch (error) {
      console.warn("[Session Timer] Could not unlock audio:", error);
      updateAudioState();
      return false;
    }
  }

  function stopSounds(activeSounds) {
    if (audioContext && audioContext.state !== "closed") {
      const now = audioContext.currentTime;
      for (const [source, gain] of activeSounds) {
        gain.disconnect();
        source.stop(now);
      }
    }
    activeSounds.clear();
  }

  function stopPreview() {
    previewRequest = null;
    stopSounds(previewSounds);
  }

  function connectSound(source, gain, output, activeSounds) {
    source.connect(gain);
    gain.connect(output);
    activeSounds.set(source, gain);
    source.onended = () => {
      if (activeSounds.delete(source)) {
        gain.disconnect();
      }
      source.disconnect();
    };
  }

  function playAlertSound(
    group,
    start,
    output,
    activeSounds,
    volume,
    stopAt = Infinity,
  ) {
    const sound = alertSounds[group];
    const buffer = customSounds.get(sound)?.buffer;
    if (buffer) {
      const duration = Math.min(buffer.duration, stopAt - start);
      if (duration > 0) {
        const source = audioContext.createBufferSource();
        const gain = audioContext.createGain();
        source.buffer = buffer;
        gain.gain.value = volume;
        connectSound(source, gain, output, activeSounds);
        source.start(start, 0, duration);
      }
      return;
    }
    playChime(group, start, output, activeSounds, volume, stopAt);
  }

  function playChime(group, start, output, activeSounds, volume, stopAt) {
    const { level, notes } = CHIMES[group];
    const style =
      ALERT_SOUNDS[alertSounds[group]] ?? ALERT_SOUNDS[DEFAULT_ALERT_SOUND];
    if (
      stopAt !== Infinity &&
      notes.some(
        ([offset, , length]) => start + offset + length * style.length > stopAt,
      )
    ) {
      return;
    }
    for (const [offset, frequency, duration] of notes) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = start + offset;
      const noteEnd = noteStart + duration * style.length;
      if (style.waveform === "custom") {
        bellWave ??= audioContext.createPeriodicWave(
          new Float32Array(6),
          new Float32Array([0, 1, 0.18, 0.32, 0, 0.24]),
        );
        oscillator.setPeriodicWave(bellWave);
      } else {
        oscillator.type = style.waveform;
      }
      oscillator.frequency.setValueAtTime(frequency * style.pitch, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(
        level * style.level * volume,
        noteStart + style.attack,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      connectSound(oscillator, gain, output, activeSounds);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
    }
  }

  async function testSound(group) {
    const volume = alertVolumes[group];
    if (volume === 0) {
      return;
    }
    stopPreview();
    const request = (previewRequest = Symbol());
    if (!(await unlockAudio())) {
      return;
    }
    await loadCustomSound(alertSounds[group]);
    if (previewRequest !== request || !isAudioUnlocked) {
      return;
    }
    playAlertSound(
      group,
      audioContext.currentTime + AUDIO_START_DELAY_SECONDS,
      audioContext.destination,
      previewSounds,
      volume / 100,
    );
  }

  async function toggleMute() {
    if (!isAudioUnlocked && !isMuted) {
      await unlockAudio();
      return;
    }
    if (isMuted && !isAudioUnlocked) {
      lastHandledCueAt = getElapsedMs();
    }
    isMuted = !isMuted;
    void saveTimerSession();
    updateOutputVolumes();
    if (isMuted) {
      stopPreview();
    } else if (!isAudioUnlocked) {
      await unlockAudio();
    }
    updateAudioButton();
  }

  // =========================
  // Styles
  // =========================

  function injectStyles() {
    const style = document.createElement("style");
    style.id = "session-timer-styles";
    style.textContent = `
      #session-timer-overlay {
        --st-bg: #fcfcfa;
        --st-text: #272824;
        --st-muted: #62665e;
        --st-line: #daddd4;
        --st-hover: #eeefe9;
        --st-accent: #38644b;
        --st-warning: #995800;
        --st-near-end: #c2450a;
        --st-danger: #a73532;
        --st-phase: var(--st-accent);
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483646;
        width: min(254px, calc(100vw - 16px));
        max-height: calc(100vh - 12px);
        overflow: auto;
        border: 1px solid var(--st-line);
        border-radius: 6px;
        background: var(--st-bg);
        box-shadow: 0 4px 16px #20231c22;
        color: var(--st-text);
        color-scheme: light;
        font: 12px/1.4 system-ui, sans-serif;
        text-align: left;
      }
      @media (prefers-color-scheme: dark) {
        #session-timer-overlay {
          --st-bg: #21231f;
          --st-text: #f1f2ec;
          --st-muted: #b7bcb0;
          --st-line: #40453b;
          --st-hover: #34392f;
          --st-accent: #a5cbb0;
          --st-warning: #ffc47c;
          --st-near-end: #ff8c4c;
          --st-danger: #ff9d96;
          color-scheme: dark;
        }
      }
      #session-timer-overlay,
      #session-timer-overlay * { box-sizing: border-box; }
      #session-timer-overlay [hidden] { display: none !important; }
      #session-timer-overlay[data-phase="alert"] { --st-phase: var(--st-warning); }
      #session-timer-overlay[data-phase="near-end"] { --st-phase: var(--st-near-end); }
      #session-timer-overlay[data-phase="overdue"] { --st-phase: var(--st-danger); }
      #session-timer-overlay.st-collapsed { width: max-content; max-width: calc(100vw - 16px); }

      #session-timer-overlay .st-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 5px;
        padding: 7px 7px 6px 10px;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      #session-timer-overlay .st-header.st-dragging { cursor: grabbing; }
      #session-timer-overlay .st-clock {
        display: flex;
        flex: 1;
        align-items: baseline;
        gap: 5px;
        min-width: 0;
        color: var(--st-muted);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #session-timer-overlay .st-elapsed {
        color: var(--st-text);
        font-size: 21px;
        font-weight: 650;
        line-height: 1.2;
        letter-spacing: -.035em;
      }
      #session-timer-overlay[data-phase="overdue"] .st-elapsed { color: var(--st-danger); }
      #session-timer-overlay .st-icon {
        display: inline-grid;
        flex: 0 0 26px;
        place-items: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--st-muted);
        cursor: pointer;
      }
      #session-timer-overlay .st-icon svg { width: 16px; height: 16px; pointer-events: none; }
      #session-timer-overlay .st-icon:hover,
      #session-timer-overlay .st-icon[aria-controls="st-details"][aria-expanded="true"] {
        background: var(--st-hover);
        color: var(--st-text);
      }
      #session-timer-overlay .st-icon[data-audio="locked"] { color: var(--st-warning); }
      #session-timer-overlay .st-icon[data-audio="muted"] { color: var(--st-danger); }
      #session-timer-overlay .st-progress {
        height: 4px;
        overflow: hidden;
        background: var(--st-line);
      }
      #session-timer-overlay .st-progress-fill {
        height: 100%;
        background: var(--st-phase);
        transform: scaleX(0);
        transform-origin: left;
      }

      #session-timer-overlay .st-body { padding: 5px 7px 5px 10px; }
      #session-timer-overlay .st-controls {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 27px;
      }
      #session-timer-overlay .st-remaining {
        flex: 1;
        color: var(--st-muted);
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #session-timer-overlay[data-phase="overdue"] .st-remaining { color: var(--st-danger); }
      #session-timer-overlay .st-select,
      #session-timer-overlay .st-input,
      #session-timer-overlay .st-sound-action {
        min-width: 0;
        min-height: 25px;
        margin: 0;
        padding: 2px 5px;
        border: 1px solid var(--st-line);
        border-radius: 5px;
        background: var(--st-bg);
        color: var(--st-text);
        font: inherit;
      }
      #session-timer-overlay .st-select { cursor: pointer; }
      #session-timer-overlay .st-custom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin: 4px 2px 3px 0;
        color: var(--st-muted);
      }
      #session-timer-overlay .st-input { width: 76px; }
      #session-timer-overlay .st-input[aria-invalid="true"] { border-color: var(--st-danger); }

      #session-timer-overlay .st-details {
        display: grid;
        gap: 7px;
        margin: 4px 0 1px;
        padding-top: 8px;
        border-top: 1px solid var(--st-line);
        color: var(--st-muted);
      }
      #session-timer-overlay .st-sound-group { display: grid; gap: 5px; }
      #session-timer-overlay .st-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--st-text);
        cursor: pointer;
      }
      #session-timer-overlay .st-toggle input {
        margin: 0;
        accent-color: var(--st-accent);
      }
      #session-timer-overlay .st-alert-heading { color: var(--st-text); }
      #session-timer-overlay .st-sound-group + .st-sound-group {
        border-top: 1px solid var(--st-line);
        padding-top: 7px;
      }
      #session-timer-overlay .st-preview {
        color: var(--st-muted);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        margin-left: 6px;
      }
      #session-timer-overlay .st-timing {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 5px;
      }
      #session-timer-overlay .st-timing .st-input { text-align: right; }
      #session-timer-overlay .st-timing .st-select { min-width: 90px; max-width: 72%; }
      #session-timer-overlay .st-timing-input {
        display: inline-grid;
        grid-template-columns: auto 1em;
        align-items: center;
        gap: 4px;
      }
      #session-timer-overlay .st-volume {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 35px 26px;
        align-items: center;
        column-gap: 5px;
      }
      #session-timer-overlay .st-volume label {
        color: var(--st-muted);
        font-size: 11px;
      }
      #session-timer-overlay .st-volume input {
        grid-column: 1 / 3;
        width: 100%;
        height: 14px;
        margin: 0;
        accent-color: var(--st-accent);
        cursor: pointer;
      }
      #session-timer-overlay .st-volume output {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #session-timer-overlay .st-volume button {
        grid-column: 3;
        grid-row: 1 / span 2;
      }
      #session-timer-overlay .st-volume :disabled { cursor: default; opacity: .5; }
      #session-timer-overlay .st-custom-sound {
        border-top: 1px solid var(--st-line);
        padding-top: 6px;
      }
      #session-timer-overlay .st-custom-sound summary {
        color: var(--st-text);
        cursor: pointer;
      }
      #session-timer-overlay .st-custom-sound form,
      #session-timer-overlay .st-sound-name {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 4px;
      }
      #session-timer-overlay .st-custom-sound form { gap: 8px; margin-top: 8px; }
      #session-timer-overlay .st-custom-sound :is(.st-input, .st-select) { width: 100%; }
      #session-timer-overlay .st-custom-sound span { overflow-wrap: anywhere; }
      #session-timer-overlay .st-custom-sound [data-error] { color: var(--st-danger); }
      #session-timer-overlay .st-sound-action { width: 100%; cursor: pointer; }
      #session-timer-overlay .st-sound-action:hover:not(:disabled) {
        border-color: var(--st-accent);
      }
      #session-timer-overlay .st-sound-save {
        border-color: var(--st-accent);
        background: var(--st-accent);
        color: var(--st-bg);
        font-weight: 600;
      }
      #session-timer-overlay .st-delete-sound {
        border-top: 1px solid var(--st-line);
        padding-top: 8px;
      }
      #session-timer-overlay .st-sound-delete { color: var(--st-danger); }
      #session-timer-overlay .st-custom-sound :disabled { cursor: default; opacity: .5; }
      #session-timer-overlay .st-custom-sound [role="status"]:empty {
        position: absolute;
      }
      #session-timer-overlay .st-settings-actions {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        border-top: 1px solid var(--st-line);
        padding-top: 6px;
      }
      #session-timer-overlay .st-restore,
      #session-timer-overlay .st-reset {
        margin: 0;
        padding: 2px 0;
        border: 0;
        background: transparent;
        color: var(--st-text);
        font: inherit;
        cursor: pointer;
      }
      #session-timer-overlay .st-reset { color: var(--st-danger); }
      #session-timer-overlay .st-restore:hover,
      #session-timer-overlay .st-reset:hover { text-decoration: underline; }
      #session-timer-overlay :is(button, select, input, summary):focus-visible {
        outline: 2px solid var(--st-accent);
        outline-offset: 1px;
      }
    `;
    document.getElementById(style.id)?.remove();
    document.head.appendChild(style);
  }

  // =========================
  // Preferences
  // =========================

  function configuredOrigin(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const url = new URL(value.trim());
      return url.protocol === "https:" || url.protocol === "http:"
        ? url.origin
        : null;
    } catch {
      return null;
    }
  }

  function readTimerConfig() {
    if (typeof GM_getValue !== "function") {
      return null;
    }
    const config = GM_getValue(CONFIG_KEY, null);
    if (config === null && typeof GM_setValue === "function") {
      GM_setValue(CONFIG_KEY, {
        startupOrigin: "",
        workOrigin: "",
        readySelector: "",
      });
    }
    const workOrigin = configuredOrigin(config?.workOrigin);
    if (workOrigin === null) {
      return null;
    }
    return {
      workOrigin,
      startupOrigin: configuredOrigin(config.startupOrigin),
      startupPath:
        typeof config.startupPath === "string" ? config.startupPath.trim() : "",
      readySelector:
        typeof config.readySelector === "string"
          ? config.readySelector.trim()
          : "",
    };
  }

  function readPreferences() {
    if (
      typeof GM_getValue === "function" &&
      typeof GM_setValue === "function"
    ) {
      return Object.fromEntries(
        PREFERENCE_NAMES.map((name) => [
          name,
          GM_getValue(`${PREFERENCES_KEY}.${name}`),
        ]),
      );
    }
    return readLegacyPreferences();
  }

  function isAlertSound(id) {
    return (
      typeof id === "string" &&
      (Object.hasOwn(ALERT_SOUNDS, id) || customSounds.has(id))
    );
  }

  function restoreCustomSounds() {
    if (typeof GM_listValues !== "function") {
      return;
    }
    const keys = new Set(GM_listValues());
    const removed = [];
    for (const id of customSounds.keys()) {
      if (!keys.has(id)) {
        customSounds.delete(id);
        removed.push(id);
      }
    }
    let added = false;
    for (const id of keys) {
      if (!id.startsWith(CUSTOM_SOUND_PREFIX) || customSounds.has(id)) {
        continue;
      }
      const saved = GM_getValue(id);
      if (typeof saved?.label === "string" && typeof saved.data === "string") {
        customSounds.set(id, { label: saved.label });
        added = true;
      }
    }
    if (added || removed.length > 0) {
      refreshCustomSoundControls(removed);
    }
  }

  function readLegacyPreferences() {
    try {
      return JSON.parse(localStorage.getItem(PREFERENCES_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  function savePreferences(changes) {
    try {
      if (
        typeof GM_getValue === "function" &&
        typeof GM_setValue === "function"
      ) {
        for (const [name, value] of Object.entries(changes)) {
          GM_setValue(`${PREFERENCES_KEY}.${name}`, value);
        }
        return;
      }
      localStorage.setItem(
        PREFERENCES_KEY,
        JSON.stringify({ ...readPreferences(), ...changes }),
      );
    } catch {
      // The timer still works when the browser blocks local storage.
    }
  }

  function migratePreferences() {
    if (
      typeof GM_getValue !== "function" ||
      typeof GM_setValue !== "function" ||
      location.origin !== timerConfig.workOrigin
    ) {
      return;
    }
    const key = `${PREFERENCES_KEY}.migrated`;
    if (GM_getValue(key, false)) {
      return;
    }
    const legacy = readLegacyPreferences();
    const current = readPreferences();
    for (const name of PREFERENCE_NAMES) {
      if (current[name] === undefined && Object.hasOwn(legacy, name)) {
        GM_setValue(`${PREFERENCES_KEY}.${name}`, legacy[name]);
      }
    }
    GM_setValue(key, true);
  }

  function parseMinutes(value) {
    const minutes = Number(value);
    const milliseconds = minutes * 60_000;
    return milliseconds > 0 && milliseconds <= Number.MAX_SAFE_INTEGER
      ? minutes
      : null;
  }

  function validAlertTiming(key, value) {
    if (key.endsWith("Enabled")) {
      return typeof value === "boolean";
    }
    if (key.endsWith("Start")) {
      return Number.isFinite(value) && value >= 0 && value <= 1;
    }
    return (
      Number.isInteger(value) &&
      value >= 0 &&
      Number.isSafeInteger(value * 1000)
    );
  }

  function restorePreferences() {
    const preferences = readPreferences();
    const { preset, custom, collapsed, position } = preferences;
    if (typeof custom === "string" && parseMinutes(custom) !== null) {
      customMinutes = custom;
    }
    if (preset === "custom" || TARGET_PRESETS.includes(Number(preset))) {
      selectedPreset = String(preset);
    }
    targetMinutes = Number(
      selectedPreset === "custom" ? customMinutes : selectedPreset,
    );
    for (const group of Object.keys(alertVolumes)) {
      const volume = preferences[`${group}Volume`];
      if (Number.isInteger(volume) && volume >= 0 && volume <= 100) {
        alertVolumes[group] = volume;
      }
      const sound = preferences[`${group}Sound`];
      if (isAlertSound(sound)) {
        alertSounds[group] = sound;
        void loadCustomSound(sound);
      }
    }
    for (const key of Object.keys(alertTiming)) {
      if (validAlertTiming(key, preferences[key])) {
        alertTiming[key] = preferences[key];
      }
    }
    isCollapsed = collapsed === true;
    if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
      panelPosition = position;
    }
  }

  // =========================
  // Panel
  // =========================

  const ICONS = {
    chevronDown: "m5 7 5 5 5-5",
    chevronUp: "m5 12 5-5 5 5",
    settings: "M3 5h14M3 10h14M3 15h14M8 3v4m5 1v4m-8 1v4",
    sound: "M3 8v4h3l4 3V5L6 8H3m10 0a3 3 0 0 1 0 4m2-6a6 6 0 0 1 0 8",
    muted: "M3 8v4h3l4 3V5L6 8H3m10 0 4 4m0-4-4 4",
    locked: "M3 8v4h3l4 3V5L6 8H3m12-2v5m0 3h.01",
    test: "M4 10h2l2-4 3 8 2-4h3M5 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
  };

  function setButtonIcon(button, icon, label) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", ICONS[icon]);
    svg.append(path);
    button.replaceChildren(svg);
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function createIconButton(icon, label, action) {
    const button = createElement("button", {
      className: "st-icon",
      type: "button",
    });
    setButtonIcon(button, icon, label);
    button.addEventListener("click", action);
    return button;
  }

  function updateAudioButton() {
    if (!muteButton) {
      return;
    }
    if (isMuted) {
      setButtonIcon(muteButton, "muted", "Unmute alerts");
      muteButton.dataset.audio = "muted";
    } else if (isAudioUnlocked) {
      setButtonIcon(muteButton, "sound", "Mute alerts");
      muteButton.dataset.audio = "enabled";
    } else {
      setButtonIcon(muteButton, "locked", "Enable alert sounds");
      muteButton.dataset.audio = "locked";
    }
  }

  function enableAudioOnInteraction(event) {
    if (!event.isTrusted || isAudioUnlocked || isMuted) {
      return;
    }
    if (event.type === "keydown" && (event.repeat || event.key === "Escape")) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("[data-st-audio-action]")
    ) {
      return;
    }
    void unlockAudio();
  }

  function createTargetControls() {
    const picker = createElement("select", { className: "st-select" });
    picker.setAttribute("aria-label", "Time limit");
    picker.title = "Time limit";

    for (const minutes of TARGET_PRESETS) {
      const label = minutes === 60 ? "1 h" : `${minutes} min`;
      picker.add(new Option(label, String(minutes)));
    }
    picker.add(new Option("Custom", "custom"));
    picker.value = selectedPreset;

    customRow = createElement("label", { className: "st-custom" });
    customInput = createElement("input", {
      className: "st-input",
      type: "number",
    });
    customInput.step = "any";
    customInput.inputMode = "decimal";
    customInput.value = customMinutes;
    appendChildren(
      customRow,
      createElement("span", { text: "Custom minutes" }),
      customInput,
    );
    customRow.hidden = selectedPreset !== "custom";

    picker.addEventListener("change", () => {
      selectedPreset = picker.value;
      savePreferences({ preset: selectedPreset });
      customRow.hidden = selectedPreset !== "custom";
      if (customRow.hidden) {
        setTargetMinutes(Number(selectedPreset));
      } else {
        customInput.value = customMinutes;
        customInput.removeAttribute("aria-invalid");
        customInput.setCustomValidity("");
        setTargetMinutes(Number(customMinutes));
        customInput.focus();
        customInput.select();
      }
    });

    customInput.addEventListener("input", () => {
      window.clearTimeout(customCommitTimeout);
      customInput.removeAttribute("aria-invalid");
      customInput.setCustomValidity("");
      if (parseMinutes(customInput.value) !== null) {
        customCommitTimeout = window.setTimeout(commitCustomMinutes, 450);
      }
    });
    customInput.addEventListener("blur", () => commitCustomMinutes());
    customInput.addEventListener("change", () => commitCustomMinutes());
    customInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (commitCustomMinutes()) {
          customInput.blur();
        } else {
          customInput.reportValidity();
        }
      }
    });
    window.addEventListener("pagehide", () => commitCustomMinutes());

    return picker;
  }

  function commitCustomMinutes() {
    window.clearTimeout(customCommitTimeout);
    if (selectedPreset !== "custom") {
      return false;
    }

    const minutes = parseMinutes(customInput.value);
    if (minutes === null) {
      customInput.setAttribute("aria-invalid", "true");
      customInput.setCustomValidity("Enter a positive number of minutes.");
      return false;
    }

    customInput.removeAttribute("aria-invalid");
    customInput.setCustomValidity("");
    if (customMinutes !== customInput.value) {
      customMinutes = customInput.value;
      savePreferences({ custom: customMinutes });
    }
    setTargetMinutes(minutes);
    return true;
  }

  function setDetailsOpen(open) {
    detailsPanel.hidden = !open;
    settingsButton.setAttribute("aria-expanded", String(open));
    if (open) {
      restoreCustomSounds();
      render();
      updateAlertPreview();
    }
    placePanel();
  }

  function setCollapsed(collapsed) {
    isCollapsed = collapsed;
    overlay.classList.toggle("st-collapsed", collapsed);
    bodyPanel.hidden = collapsed;
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    setButtonIcon(
      collapseButton,
      collapsed ? "chevronDown" : "chevronUp",
      collapsed ? "Expand timer" : "Collapse timer",
    );
    if (collapsed) {
      setDetailsOpen(false);
    } else {
      render();
      placePanel();
    }
  }

  function createVolumeControl(group, testLabel) {
    const id = `st-${group}-volume`;
    const row = createElement("div", { className: "st-volume" });
    const label = createElement("label", { text: "Volume" });
    label.htmlFor = id;

    const level = createElement("output");
    level.setAttribute("aria-hidden", "true");
    const slider = createElement("input", { id, type: "range" });
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    const testButton = createIconButton("test", testLabel, () =>
      testSound(group),
    );
    testButton.dataset.stAudioAction = "";
    function showValue(value) {
      slider.value = String(value);
      level.textContent = `${value}%`;
      slider.setAttribute("aria-valuetext", value === 0 ? "Off" : `${value}%`);
    }
    showValue(alertVolumes[group]);
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      alertVolumes[group] = value;
      savePreferences({ [`${group}Volume`]: value });
      showValue(value);
      updateOutputVolumes();
    });
    appendChildren(row, label, level, slider, testButton);
    return { row, slider, testButton, showValue };
  }

  function createSoundControl(group) {
    const picker = createElement("select", {
      id: `st-${group}-sound`,
      className: "st-select",
    });
    for (const [style, { label }] of Object.entries(ALERT_SOUNDS)) {
      picker.add(new Option(label, style));
    }
    const customOptions = createElement("optgroup");
    customOptions.label = "Custom sounds";
    customOptions.hidden = customSounds.size === 0;
    customOptions.append(...createCustomSoundOptions());
    picker.append(customOptions);
    picker.value = alertSounds[group];
    picker.addEventListener("change", () => {
      const sound = picker.value;
      if (!isAlertSound(sound) || alertSounds[group] === sound) {
        return;
      }
      alertSounds[group] = sound;
      savePreferences({ [`${group}Sound`]: sound });
      stopPreview();
      void loadCustomSound(sound);
      refreshAlertSchedule();
    });
    const row = appendChildren(
      createElement("label", { className: "st-timing" }),
      createElement("span", { text: "Sound" }),
      picker,
    );
    return { row, picker, customOptions };
  }

  function createCustomSoundOptions() {
    return Array.from(customSounds, ([id, { label }]) => new Option(label, id));
  }

  function refreshCustomSoundControls(removed = []) {
    if (!alertSettings) {
      return;
    }
    const defaults = {};
    let selectionChanged = false;
    for (const [group, settings] of Object.entries(alertSettings)) {
      const { picker, customOptions } = settings.sound;
      if (removed.length > 0) {
        const preference = `${group}Sound`;
        const saved = GM_getValue(`${PREFERENCES_KEY}.${preference}`);
        if (removed.includes(saved)) {
          defaults[preference] = DEFAULT_ALERT_SOUND;
        }
      }
      if (!isAlertSound(alertSounds[group])) {
        alertSounds[group] = DEFAULT_ALERT_SOUND;
        selectionChanged = true;
      }
      customOptions.replaceChildren(...createCustomSoundOptions());
      customOptions.hidden = customSounds.size === 0;
      picker.value = alertSounds[group];
    }
    if (Object.keys(defaults).length > 0) {
      savePreferences(defaults);
    }
    if (selectionChanged) {
      stopPreview();
      refreshAlertSchedule();
    }
    customSoundLibrary?.refresh();
  }

  function readAudioFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new Error("Audio file read was cancelled."));
      reader.readAsDataURL(file);
    });
  }

  function createCustomSoundSettings() {
    const section = createElement("details", { className: "st-custom-sound" });
    const form = createElement("form");
    const name = createElement("input", {
      className: "st-input",
      type: "text",
    });
    name.disabled = true;
    const nameLabel = appendChildren(
      createElement("label", { className: "st-sound-name" }),
      createElement("span", { text: "Sound name" }),
      name,
    );
    // Keep the selected file out of the host page's DOM.
    const fileInput = createElement("input", { type: "file" });
    fileInput.accept = "audio/*,.aac,.flac,.m4a,.mp3,.ogg,.opus,.wav,.webm";
    const choose = createElement("button", {
      className: "st-sound-action",
      text: "Choose audio file",
      type: "button",
    });
    const add = createElement("button", {
      className: "st-sound-action st-sound-save",
      text: "Add sound",
      type: "submit",
    });
    add.disabled = true;
    const fileName = createElement("span", { id: "st-custom-sound-file-name" });
    fileName.hidden = true;
    choose.setAttribute("aria-describedby", fileName.id);
    const status = createElement("span");
    status.setAttribute("role", "status");
    let suggestedName = "";

    choose.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      const nextName = file ? file.name.replace(/\.[^.]+$/, "") || file.name : "";
      if (!name.value.trim() || name.value === suggestedName) {
        name.value = nextName;
      }
      suggestedName = nextName;
      choose.textContent = file ? "Change audio file" : "Choose audio file";
      fileName.textContent = file?.name ?? "";
      fileName.hidden = !file;
      add.disabled = name.disabled = !file;
      delete status.dataset.error;
      status.textContent = "";
      if (file) {
        name.focus();
        name.select();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (add.disabled) {
        return;
      }
      const label = name.value.trim();
      const file = fileInput.files[0];
      if (!label || !file) {
        status.dataset.error = "";
        status.textContent = file
          ? "Enter a name for the sound."
          : "Choose an audio file.";
        (file ? name : choose).focus();
        return;
      }

      add.disabled = choose.disabled = name.disabled = true;
      delete status.dataset.error;
      status.textContent = "Adding sound…";
      let errorMessage =
        "Could not read this audio file. Try a supported format such as MP3 or WAV.";
      try {
        const data = await readAudioFile(file);
        const buffer = await decodeCustomSound(data);
        const id =
          CUSTOM_SOUND_PREFIX + crypto.getRandomValues(new Uint32Array(4)).join("-");
        errorMessage = "Could not save the sound in Tampermonkey.";
        await GM.setValue(id, { label, data });
        customSounds.set(id, { label, buffer });
        refreshCustomSoundControls();
        form.reset();
        fileInput.value = "";
        suggestedName = "";
        choose.textContent = "Choose audio file";
        fileName.textContent = "";
        fileName.hidden = true;
        status.textContent = `Added “${label}”. Select it from any Sound list.`;
      } catch (error) {
        status.dataset.error = "";
        status.textContent = errorMessage;
        console.warn("[Session Timer] Could not add custom sound:", error);
      } finally {
        choose.disabled = false;
        add.disabled = name.disabled = fileInput.files.length === 0;
      }
    });
    appendChildren(form, choose, fileName, nameLabel, add, status);
    customSoundLibrary = createCustomSoundLibrary();
    return appendChildren(
      section,
      createElement("summary", { text: "Custom sounds" }),
      form,
      customSoundLibrary.row,
    );
  }

  function createCustomSoundLibrary() {
    const form = createElement("form", { className: "st-delete-sound" });
    const picker = createElement("select", { className: "st-select" });
    const label = appendChildren(
      createElement("label", { className: "st-sound-name" }),
      createElement("span", { text: "Sound to delete" }),
      picker,
    );
    const remove = createElement("button", {
      className: "st-sound-action st-sound-delete",
      text: "Delete sound",
      type: "submit",
    });
    const status = createElement("span");
    status.setAttribute("role", "status");
    let deleting = false;

    function refresh() {
      const selected = picker.value;
      picker.replaceChildren(
        new Option("Select a sound", ""),
        ...createCustomSoundOptions(),
      );
      picker.value = customSounds.has(selected) ? selected : "";
      picker.disabled = deleting;
      remove.disabled = deleting || !picker.value;
      form.hidden = customSounds.size === 0;
    }

    picker.addEventListener("change", () => {
      remove.disabled = !picker.value;
      delete status.dataset.error;
      status.textContent = "";
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = picker.value;
      const sound = customSounds.get(id);
      if (deleting || !sound) {
        return;
      }
      deleting = picker.disabled = remove.disabled = true;
      delete status.dataset.error;
      status.textContent = "Deleting sound…";
      try {
        await GM.deleteValue(id);
        customSounds.delete(id);
        refreshCustomSoundControls([id]);
        status.textContent = `Deleted “${sound.label}”.`;
      } catch (error) {
        status.dataset.error = "";
        status.textContent = "Could not delete the sound in Tampermonkey.";
        console.warn("[Session Timer] Could not delete custom sound:", error);
      } finally {
        deleting = false;
        refresh();
      }
    });

    appendChildren(form, label, remove);
    refresh();
    return { row: appendChildren(createElement("div"), form, status), refresh };
  }

  function createTimingControl(
    key,
    text,
    zeroHint = "0 s = play the first signal only.",
  ) {
    const isStart = key.endsWith("Start");
    const row = createElement("label", { className: "st-timing" });
    const label = createElement("span", { text });
    const input = createElement("input", {
      id: `st-${key}`,
      className: "st-input",
      type: "number",
    });
    input.min = "0";
    input.step = isStart ? "any" : "1";
    input.inputMode = isStart ? "decimal" : "numeric";
    input.setAttribute(
      "aria-label",
      `${text} (${isStart ? "percent" : "seconds"})`,
    );
    let savedText;
    if (isStart) {
      input.max = "100";
      row.title = "0% = at startup. 100% = this group off.";
    } else {
      row.title = zeroHint;
    }
    const unit = createElement("span", { text: isStart ? "%" : "s" });
    unit.setAttribute("aria-hidden", "true");
    const control = appendChildren(
      createElement("span", { className: "st-timing-input" }),
      input,
      unit,
    );

    function showValue(value) {
      savedText = isStart
        ? String(Number((value * 100).toPrecision(15)))
        : String(value);
      if (isStart && value === DEFAULT_ALERT_TIMING[key]) {
        savedText = (value * 100).toFixed(2);
      }
      input.value = savedText;
      input.removeAttribute("aria-invalid");
      input.setCustomValidity("");
    }
    showValue(alertTiming[key]);

    function readValue() {
      if (input.value === savedText) {
        return alertTiming[key];
      }
      const entered = input.value === "" ? NaN : Number(input.value);
      const valid = isStart
        ? Number.isFinite(entered) && entered >= 0 && entered <= 100
        : validAlertTiming(key, entered);
      return valid ? (isStart ? entered / 100 : entered) : null;
    }

    function commit() {
      const value = readValue();
      if (value === null) {
        input.setAttribute("aria-invalid", "true");
        input.setCustomValidity(
          isStart
            ? "Enter a percentage from 0 to 100."
            : "Enter a whole number of seconds, 0 or more.",
        );
        input.reportValidity();
        return;
      }
      savedText = input.value;
      if (alertTiming[key] !== value) {
        alertTiming[key] = value;
        savePreferences({ [key]: value });
        refreshAlertSchedule();
      }
      updateAlertPreview();
    }
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      input.setCustomValidity("");
      updateAlertPreview();
    });
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    appendChildren(row, label, control);
    return { row, input, readValue, showValue };
  }

  function refreshAlertSchedule() {
    lastHandledCueAt = getElapsedMs();
    clearAlertSchedule();
    void saveTimerSession();
    scheduleAlerts();
    render();
  }

  function updateReminderPreview(settings, target, until) {
    const {
      enabled,
      controls,
      start,
      repeat,
      volume,
      sound,
      firstPreview,
      repeatPreview,
    } = settings;
    controls.hidden = !enabled.checked;
    if (controls.hidden) {
      return;
    }
    const threshold = start.readValue();
    const interval = repeat.readValue();
    const first = target * threshold;
    const remindersOff = threshold !== null && first >= until;
    volume.slider.disabled = remindersOff;
    volume.testButton.disabled = remindersOff;
    sound.picker.disabled = remindersOff;
    repeat.input.disabled = remindersOff;
    repeat.row.hidden = remindersOff;
    firstPreview.hidden = threshold === null;
    repeatPreview.hidden =
      remindersOff || threshold === null || interval === null;

    if (threshold !== null) {
      let message = `First reminder at ${formatTime(first)}`;
      if (remindersOff) {
        message =
          threshold === 1
            ? "Reminders off at 100%."
            : "Near end reminders start first.";
      }
      setText(firstPreview, message);
    }
    if (!repeatPreview.hidden) {
      const series = createCueSeries(
        settings.group,
        first,
        interval * 1000,
        until,
      );
      if (interval === 0) {
        setText(repeatPreview, "No repeats · first reminder only");
      } else if (series.lastIndex < 1) {
        setText(
          repeatPreview,
          until < target
            ? "No repeats before near end reminders."
            : "No repeats before the limit.",
        );
      } else if (series.lastIndex === 1) {
        setText(
          repeatPreview,
          `Only repeat at ${formatTime(cueTime(series, 1))}`,
        );
      } else {
        const firstRepeat = formatTime(cueTime(series, 1));
        const lastRepeat = formatTime(cueTime(series, series.lastIndex));
        const between = series.lastIndex - 2;
        const summary =
          between === 0
            ? `${firstRepeat} → ${lastRepeat}`
            : `${firstRepeat} → ${between} in between → ${lastRepeat}`;
        setText(repeatPreview, summary);
      }
    }
  }

  function updateAlertPreview() {
    if (!alertSettings) {
      return;
    }
    const { reminder, nearEnd, end } = alertSettings;
    const target = getTargetMs();
    const threshold = nearEnd.start.readValue() ?? alertTiming.nearEndStart;
    const nearEndAt = getReminderStartTime(
      target,
      nearEnd.enabled.checked,
      threshold,
    );
    updateReminderPreview(reminder, target, nearEndAt);
    updateReminderPreview(nearEnd, target, target);

    const endInterval = end.repeat.readValue();
    const giveUpSeconds = end.giveUp.readValue();
    const cutoff = getEndAlertCutoff(
      target,
      giveUpSeconds ?? alertTiming.endGiveUpSeconds,
    );
    end.preview.hidden = endInterval === null;
    if (endInterval !== null) {
      const firstRepeat = target + endInterval * 1000;
      const summary =
        endInterval === 0 || firstRepeat >= cutoff
          ? `End alert at ${formatTime(target)} · no repeats`
          : `First repeat at ${formatTime(firstRepeat)}`;
      setText(end.preview, summary);
    }
    end.cutoffPreview.hidden = giveUpSeconds === null;
    if (!end.cutoffPreview.hidden) {
      setText(
        end.cutoffPreview,
        giveUpSeconds === 0 ? "No cutoff" : `Cutoff at ${formatTime(cutoff)}`,
      );
    }
  }

  function restoreAlertDefaults() {
    Object.assign(alertTiming, DEFAULT_ALERT_TIMING);
    Object.assign(alertVolumes, DEFAULT_ALERT_VOLUMES);
    const preferences = { ...alertTiming };
    alertSettings.end.giveUp.showValue(alertTiming.endGiveUpSeconds);
    for (const group of Object.keys(alertVolumes)) {
      const { start, enabled, repeat, volume, sound } = alertSettings[group];
      if (enabled) {
        enabled.checked = alertTiming[`${group}Enabled`];
        start.showValue(alertTiming[`${group}Start`]);
      }
      repeat.showValue(alertTiming[`${group}Seconds`]);
      volume.showValue(alertVolumes[group]);
      alertSounds[group] = DEFAULT_ALERT_SOUND;
      sound.picker.value = DEFAULT_ALERT_SOUND;
      preferences[`${group}Volume`] = alertVolumes[group];
      preferences[`${group}Sound`] = DEFAULT_ALERT_SOUND;
    }
    savePreferences(preferences);
    stopPreview();
    updateOutputVolumes();
    refreshAlertSchedule();
    updateAlertPreview();
  }

  function createAlertPreview(id, field) {
    const preview = createElement("div", { id, className: "st-preview" });
    field.input.setAttribute("aria-describedby", id);
    return preview;
  }

  function createReminderSettings(
    group,
    label,
    testLabel,
    firstPreviewId,
    repeatPreviewId,
  ) {
    const volume = createVolumeControl(group, testLabel);
    const sound = createSoundControl(group);
    const start = createTimingControl(`${group}Start`, "Start at");
    const repeat = createTimingControl(`${group}Seconds`, "Repeat every");
    const firstPreview = createAlertPreview(firstPreviewId, start);
    const repeatPreview = createAlertPreview(repeatPreviewId, repeat);
    const controlsId =
      group === "reminder" ? "st-reminder-settings" : "st-near-end-settings";
    const controls = appendChildren(
      createElement("div", { id: controlsId, className: "st-sound-group" }),
      volume.row,
      sound.row,
      start.row,
      firstPreview,
      repeat.row,
      repeatPreview,
    );
    const enabledKey = `${group}Enabled`;
    const enabled = createElement("input", {
      id: `st-${enabledKey}`,
      type: "checkbox",
    });
    enabled.checked = alertTiming[enabledKey];
    enabled.setAttribute("aria-controls", controls.id);
    enabled.addEventListener("change", () => {
      alertTiming[enabledKey] = enabled.checked;
      savePreferences({ [enabledKey]: enabled.checked });
      refreshAlertSchedule();
      updateAlertPreview();
    });
    const toggleLabel = appendChildren(
      createElement("label", { className: "st-toggle" }),
      enabled,
      createElement("span", { text: label }),
    );
    const row = appendChildren(
      createElement("div", { className: "st-sound-group" }),
      toggleLabel,
      controls,
    );
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    return {
      group,
      row,
      enabled,
      controls,
      volume,
      sound,
      start,
      repeat,
      firstPreview,
      repeatPreview,
    };
  }

  function createAlertSettings() {
    const reminder = createReminderSettings(
      "reminder",
      "Reminders",
      "Test reminder sound",
      "st-first-preview",
      "st-repeat-preview",
    );
    const nearEnd = createReminderSettings(
      "nearEnd",
      "Near end reminders",
      "Test near end reminder sound",
      "st-near-end-first-preview",
      "st-near-end-repeat-preview",
    );

    const volume = createVolumeControl("end", "Test end alert sound");
    const sound = createSoundControl("end");
    const repeat = createTimingControl("endSeconds", "Repeat every");
    const preview = createAlertPreview("st-end-preview", repeat);
    const giveUp = createTimingControl(
      "endGiveUpSeconds",
      "Give up after",
      "0 s = never give up.",
    );
    const cutoffPreview = createAlertPreview("st-end-cutoff-preview", giveUp);
    const heading = createElement("div", {
      className: "st-alert-heading",
      text: "End alerts",
    });
    const endGroup = appendChildren(
      createElement("div", { className: "st-sound-group" }),
      heading,
      volume.row,
      sound.row,
      repeat.row,
      preview,
      giveUp.row,
      cutoffPreview,
    );
    endGroup.setAttribute("role", "group");
    endGroup.setAttribute("aria-label", "End alerts");
    alertSettings = {
      reminder,
      nearEnd,
      end: { volume, sound, repeat, preview, giveUp, cutoffPreview },
    };
    updateAlertPreview();
    return [reminder.row, nearEnd.row, endGroup];
  }

  function createOverlay() {
    overlay = createElement("section", { id: "session-timer-overlay" });
    overlay.setAttribute("aria-label", "Session Timer");

    const header = createElement("div", { className: "st-header" });
    const clock = createElement("div", { className: "st-clock" });
    elapsedElement = createElement("span", {
      className: "st-elapsed",
      text: "00:00",
    });
    targetElement = createElement("span", { className: "st-target" });
    appendChildren(
      clock,
      elapsedElement,
      createElement("span", { text: "/" }),
      targetElement,
    );

    collapseButton = createIconButton("chevronUp", "Collapse timer", () => {
      setCollapsed(!isCollapsed);
      savePreferences({ collapsed: isCollapsed });
    });
    collapseButton.setAttribute("aria-controls", "st-body");
    muteButton = createIconButton("locked", "Enable alert sounds", toggleMute);
    muteButton.dataset.stAudioAction = "";
    appendChildren(header, clock, muteButton, collapseButton);
    enableDragging(header);

    bodyPanel = createElement("div", { id: "st-body", className: "st-body" });
    const progressTrack = createElement("div", { className: "st-progress" });
    progressTrack.setAttribute("aria-hidden", "true");
    progressFill = createElement("div", { className: "st-progress-fill" });
    progressTrack.append(progressFill);

    const controls = createElement("div", { className: "st-controls" });
    const picker = createTargetControls();
    remainingElement = createElement("span", { className: "st-remaining" });
    settingsButton = createIconButton("settings", "Timer settings", () => {
      setDetailsOpen(detailsPanel.hidden);
    });
    settingsButton.setAttribute("aria-controls", "st-details");
    appendChildren(controls, picker, remainingElement, settingsButton);

    detailsPanel = createElement("div", {
      id: "st-details",
      className: "st-details",
    });
    const resetButton = createElement("button", {
      className: "st-reset",
      text: "Reset timer",
      type: "button",
    });
    const restoreButton = createElement("button", {
      className: "st-restore",
      text: "Restore defaults",
      type: "button",
    });
    restoreButton.addEventListener("click", restoreAlertDefaults);
    resetButton.addEventListener("click", () => {
      if (window.confirm("Reset the timer to 00:00?")) {
        resetTimer();
        setDetailsOpen(false);
        settingsButton.focus();
      }
    });
    bodyPanel.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        !detailsPanel.hidden &&
        (detailsPanel.contains(event.target) || event.target === settingsButton)
      ) {
        event.stopPropagation();
        setDetailsOpen(false);
        settingsButton.focus();
      }
    });
    const actions = appendChildren(
      createElement("div", { className: "st-settings-actions" }),
      restoreButton,
      resetButton,
    );
    appendChildren(
      detailsPanel,
      ...createAlertSettings(),
      createCustomSoundSettings(),
      actions,
    );
    appendChildren(bodyPanel, controls, customRow, detailsPanel);
    overlay.append(header, progressTrack, bodyPanel);
    document.body.append(overlay);

    updateAudioButton();
    setDetailsOpen(false);
    setCollapsed(isCollapsed);
    window.addEventListener("resize", () => placePanel());
    new ResizeObserver(() => placePanel()).observe(overlay);
    for (const type of ["pointerdown", "pointerup", "keydown", "click"]) {
      document.addEventListener(type, enableAudioOnInteraction, true);
    }
  }

  // =========================
  // Dragging
  // =========================

  function placePanel(position = dragPosition ?? panelPosition) {
    if (!position) {
      return;
    }

    const { offsetWidth, offsetHeight } = overlay;
    const { clientWidth, clientHeight } = document.documentElement;
    const left = clamp(
      position.left,
      0,
      Math.max(0, clientWidth - offsetWidth),
    );
    const top = clamp(
      position.top,
      0,
      Math.max(0, clientHeight - offsetHeight),
    );

    overlay.style.right = "auto";
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    return { left, top };
  }

  function enableDragging(header) {
    let drag = null;

    header.addEventListener("pointerdown", (event) => {
      if (
        drag ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.target.closest("button")
      ) {
        return;
      }

      const rect = overlay.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      header.setPointerCapture(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) {
        return;
      }
      if (
        !dragPosition &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4
      ) {
        return;
      }
      dragPosition = placePanel({
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
      });
      header.classList.add("st-dragging");
    });

    function finishDrag(event) {
      if (drag?.id !== event.pointerId) {
        return;
      }
      drag = null;
      header.classList.remove("st-dragging");
      if (dragPosition) {
        panelPosition = dragPosition;
        dragPosition = null;
        savePreferences({ position: panelPosition });
      }
    }

    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);
    header.addEventListener("lostpointercapture", finishDrag);
  }

  // =========================
  // Rendering
  // =========================

  function setText(element, value) {
    if (element.textContent !== value) {
      element.textContent = value;
    }
  }

  function render() {
    if (!overlay || !detailsPanel) {
      return;
    }

    const elapsedMs = getElapsedMs();
    const targetMs = getTargetMs();
    const reminderAt = getReminderStartTime(
      targetMs,
      alertTiming.reminderEnabled,
      alertTiming.reminderStart,
    );
    const nearEndAt = getReminderStartTime(
      targetMs,
      alertTiming.nearEndEnabled,
      alertTiming.nearEndStart,
    );
    let phase = "normal";
    if (waitingForStartup) {
      phase = "waiting";
    } else if (elapsedMs >= targetMs) {
      phase = "overdue";
    } else if (elapsedMs >= nearEndAt) {
      phase = "near-end";
    } else if (elapsedMs >= reminderAt) {
      phase = "alert";
    }
    if (overlay.dataset.phase !== phase) {
      overlay.dataset.phase = phase;
    }
    setText(elapsedElement, formatTime(elapsedMs));
    setText(targetElement, formatTime(targetMs));
    progressFill.style.transform = `scaleX(${clamp(elapsedMs / targetMs, 0, 1)})`;

    if (!isCollapsed) {
      const remaining = targetMs - elapsedMs;
      let status =
        remaining <= 0
          ? `+${formatTime(remaining)} over`
          : `${formatTime(Math.ceil(remaining / 1000) * 1000)} left`;
      if (waitingForStartup) {
        status = invalidStartupSelector
          ? "Check startup selector"
          : "Waiting for start";
      }
      setText(remainingElement, status);
    }
  }

  // =========================
  // Startup
  // =========================

  function startWhenStartupVisible() {
    if (!waitingForStartup || invalidStartupSelector) {
      return;
    }
    let matches;
    try {
      matches = document.querySelectorAll(timerConfig.readySelector);
    } catch (error) {
      invalidStartupSelector = true;
      console.warn(
        "[Session Timer] The startup CSS selector is invalid:",
        error,
      );
      return;
    }
    const visible = Array.from(matches).some((element) => {
      if (overlay?.contains(element)) {
        return false;
      }
      if (typeof element.checkVisibility === "function") {
        return element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        });
      }
      const style = window.getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.visibility === "visible" &&
        style.opacity !== "0"
      );
    });
    if (!visible) {
      return;
    }
    waitingForStartup = false;
    if (timerStartTimestamp === null) {
      timerStartTimestamp = Date.now();
      lastHandledCueAt = -1;
    }
    void saveTimerSession();
  }

  function tick() {
    if (document.body && !document.body.contains(overlay)) {
      document.body.appendChild(overlay);
    }
    startWhenStartupVisible();
    scheduleAlerts();
    capturePlayedCues();
    render();
  }

  async function saveTimerSession() {
    if (!timerTab) {
      return;
    }
    timerTab[TAB_TIMER_KEY] = {
      page: timerPage,
      startedAt: timerStartTimestamp,
      startupMarkerRequired,
      lastHandledCueAt,
      muted: isMuted,
    };
    try {
      await GM.saveTab(timerTab);
    } catch (error) {
      console.warn("[Session Timer] Could not save the tab timer:", error);
    }
  }

  async function restoreTimerSession() {
    try {
      timerTab = await GM.getTab();
      const saved = timerTab?.[TAB_TIMER_KEY];
      const navigation = performance.getEntriesByType("navigation")[0]?.type;
      const reload = navigation === "reload" && saved?.page === timerPage;
      const handoff =
        navigation !== "back_forward" &&
        saved?.page === "startup" &&
        timerPage === "target";
      if (reload || handoff) {
        const canCarryStart =
          !startupMarkerRequired || saved.startupMarkerRequired === true;
        if (
          canCarryStart &&
          Number.isFinite(saved.startedAt) &&
          saved.startedAt <= pageEnteredAt
        ) {
          timerStartTimestamp = saved.startedAt;
          lastHandledCueAt = Number.isFinite(saved.lastHandledCueAt)
            ? saved.lastHandledCueAt
            : -1;
        }
        isMuted = saved.muted === true;
      }
      await saveTimerSession();
    } catch (error) {
      console.warn("[Session Timer] Could not read the tab timer:", error);
    }
  }

  function capturePlayedCues() {
    if (timerTab) {
      rememberPlayedCues();
      if (lastHandledCueAt !== timerTab[TAB_TIMER_KEY]?.lastHandledCueAt) {
        void saveTimerSession();
      }
    }
  }

  function handleRestoredPage(event) {
    if (event.persisted) {
      isMuted = false;
      updateOutputVolumes();
      updateAudioButton();
      waitingForStartup = startupMarkerRequired;
      resetTimer();
      if (waitingForStartup) {
        tick();
      }
    }
  }

  function refreshAfterFocus() {
    if (!document.hidden) {
      restoreCustomSounds();
      if (hasUnlockedAudio && !isAudioUnlocked && !isMuted) {
        void unlockAudio();
      }
    }
    tick();
  }

  function removeExistingUi() {
    document.getElementById("session-timer-audio-gate")?.remove();

    document.getElementById("session-timer-overlay")?.remove();
  }

  function initialise() {
    try {
      removeExistingUi();
      injectStyles();
      migratePreferences();
      restoreCustomSounds();
      restorePreferences();
      createOverlay();
      startWhenStartupVisible();
      render();

      if (startupMarkerRequired) {
        document.addEventListener("click", startWhenStartupVisible, true);
      }
      document.addEventListener("visibilitychange", refreshAfterFocus);
      window.addEventListener("focus", refreshAfterFocus);
      window.addEventListener("pagehide", capturePlayedCues);
      window.addEventListener("pageshow", handleRestoredPage);
      window.setInterval(tick, UI_REFRESH_INTERVAL_MS);
      void unlockAudio();

      console.log("[Session Timer] Initialised successfully.");
    } catch (error) {
      console.error("[Session Timer] Initialisation failed:", error);

      const errorBox = createElement("div", {
        text: "Session Timer failed to initialise. Check the browser console.",
      });

      errorBox.style.cssText = `
        position: fixed;
        top: 10px;
        left: 10px;
        z-index: 2147483647;
        padding: 12px;
        background: #a40000;
        color: white;
        font-family: Arial, sans-serif;
        font-size: 14px;
      `;

      document.body?.appendChild(errorBox);
    }
  }

  function waitForDocument() {
    if (document.body && document.head) {
      initialise();
      return;
    }

    window.setTimeout(waitForDocument, 50);
  }

  if (
    typeof GM !== "undefined" &&
    typeof GM.getTab === "function" &&
    typeof GM.saveTab === "function"
  ) {
    void restoreTimerSession().then(waitForDocument);
  } else {
    waitForDocument();
  }
})();
