// Injected into the Google Meet page before any of Meet's own scripts run.
// 1. Captures every remote WebRTC audio track, mixes them, downsamples to
//    16 kHz mono PCM16 and ships ~85 ms chunks to Node via window.__yomeetAudio.
// 2. Replaces the microphone with a WebAudio stream that Node can play TTS into
//    (window.__yomeetPlay), and the camera with a canvas "notetaker" tile.
(() => {
  if (window.__yomeetInstalled) return;
  window.__yomeetInstalled = true;

  const OUT_RATE = 16000;
  const BOT_NAME = window.__yomeetBotName || 'YoMeet';
  let ctx = null;
  let mixer = null;
  let micDest = null;
  let playHead = 0;
  const playing = new Set();

  function b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new AudioContext();
    mixer = ctx.createGain();
    micDest = ctx.createMediaStreamDestination();

    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / OUT_RATE;
    let carry = 0; // fractional read position carried between buffers
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const out = new Int16Array(Math.ceil(input.length / ratio) + 1);
      let n = 0;
      let pos = carry;
      while (pos < input.length) {
        // box-filter average over the decimation window
        const start = Math.floor(pos);
        const end = Math.min(input.length, Math.floor(pos + ratio));
        let acc = 0;
        for (let i = start; i < end; i++) acc += input[i];
        const s = end > start ? acc / (end - start) : input[start];
        out[n++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
        pos += ratio;
      }
      carry = pos - input.length;
      if (window.__yomeetAudio) {
        window.__yomeetAudio(b64FromBytes(new Uint8Array(out.buffer, 0, n * 2)));
      }
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    mixer.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);

    setInterval(() => { if (ctx.state === 'suspended') ctx.resume(); }, 1000);
    return ctx;
  }

  // ---- capture remote audio -------------------------------------------------
  const seenTracks = new Set();
  function attachRemoteTrack(track) {
    if (track.kind !== 'audio' || seenTracks.has(track.id)) return;
    seenTracks.add(track.id);
    ensureCtx();
    const stream = new MediaStream([track]);
    // Chrome quirk: WebAudio only receives remote WebRTC audio if the stream is
    // also attached to a media element.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    src.connect(mixer);
    track.addEventListener('ended', () => {
      try { src.disconnect(); } catch {}
      el.srcObject = null;
      seenTracks.delete(track.id);
    });
  }

  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    class HookedPC extends OrigPC {
      constructor(...args) {
        super(...args);
        this.addEventListener('track', (ev) => attachRemoteTrack(ev.track));
      }
    }
    window.RTCPeerConnection = HookedPC;
    window.webkitRTCPeerConnection = HookedPC;
  }

  // ---- fake camera ------------------------------------------------------------
  let videoStream = null;
  function makeVideo() {
    if (videoStream) return videoStream;
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d');
    const draw = () => {
      const t = Date.now() / 1000;
      g.fillStyle = '#1f1d2b';
      g.fillRect(0, 0, c.width, c.height);
      const speaking = playHead > (ctx ? ctx.currentTime : 0);
      const r = 46 + (speaking ? 10 * Math.abs(Math.sin(t * 8)) : 2 * Math.sin(t * 2));
      g.beginPath();
      g.arc(320, 150, r, 0, Math.PI * 2);
      g.fillStyle = speaking ? '#d97757' : '#c96442';
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 30px sans-serif';
      g.textAlign = 'center';
      g.fillText(BOT_NAME, 320, 255);
      g.font = '18px sans-serif';
      g.fillStyle = '#b8b5c7';
      g.fillText('AI notetaker · transcribing this call', 320, 288);
      g.fillText(`Say "${BOT_NAME}, ..." to ask a question`, 320, 314);
    };
    draw();
    setInterval(draw, 100);
    videoStream = c.captureStream(10);
    return videoStream;
  }

  // ---- fake microphone ------------------------------------------------------
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const out = new MediaStream();
      if (constraints && constraints.audio) {
        ensureCtx();
        micDest.stream.getAudioTracks().forEach((t) => out.addTrack(t.clone()));
      }
      if (constraints && constraints.video) {
        makeVideo().getVideoTracks().forEach((t) => out.addTrack(t.clone()));
      }
      return out;
    };
  }

  // ---- who is speaking (from Meet's own captions) ---------------------------
  // Each caption block is an avatar + the speaker's name + their words. Whenever a block's words
  // change, that person is talking right now; Node lines that up with its own transcript.
  const lastCaption = new WeakMap();
  setInterval(() => {
    const region = document.querySelector('[role="region"][aria-label="Captions"]');
    window.__yomeetCaptionsOn = !!region;
    if (!region || !window.__yomeetSpeaker) return;
    for (const block of region.querySelectorAll(':scope > div')) {
      if (!block.querySelector('img')) continue;
      const lines = block.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const text = lines.slice(1).join(' ');
      if (lastCaption.get(block) !== text) {
        lastCaption.set(block, text);
        window.__yomeetSpeaker(lines[0]);
      }
    }
  }, 250);

  // Called from Node: queue a chunk of PCM16 mono audio for playback into the mic.
  window.__yomeetPlay = (b64, sampleRate) => {
    ensureCtx();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = ctx.createBuffer(1, n, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 0x8000;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(micDest);
    const startAt = Math.max(ctx.currentTime + 0.05, playHead);
    src.start(startAt);
    playHead = startAt + buf.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
    return playHead - ctx.currentTime; // seconds of audio still queued
  };

  window.__yomeetRemaining = () => (ctx ? Math.max(0, playHead - ctx.currentTime) : 0);

  window.__yomeetStop = () => {
    playing.forEach((s) => { try { s.stop(); } catch {} });
    playing.clear();
    playHead = 0;
  };
})();
