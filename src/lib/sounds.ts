// Synthesized UI sounds — no audio assets, no licensing, ~zero bundle cost.
// The context is created lazily and reused; WebView2 may keep it suspended
// until the user has interacted with the window, so every call is best-effort.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Soft upward "whoosh" confirming a mail left the outbox. */
export function playSentSound() {
  const ac = audioContext();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const dur = 0.35;

    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buffer;

    // Rising bandpass sweep turns the noise into the "flying away" gesture.
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(500, now);
    filter.frequency.exponentialRampToValueAtTime(2800, now + dur * 0.85);

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    noise.start(now);
    noise.stop(now + dur);
  } catch {
    /* sound is a garnish — never let it break the send flow */
  }
}
