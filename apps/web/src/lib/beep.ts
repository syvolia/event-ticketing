// Web Audio beep. Two tones: a rising pair for accepted, a single low tone
// for anything else. AudioContext must be created lazily on a user gesture
// on iOS, so callers invoke `unlockAudio()` from a click handler.
let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  if (ctx) {
    void ctx.resume();
    return;
  }
  try {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, duration: number, gain: number): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.value = gain;
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + duration);
}

export function beepAccepted(): void {
  tone(880, 0, 0.08, 0.15);
  tone(1320, 0.09, 0.10, 0.15);
}

export function beepRejected(): void {
  tone(220, 0, 0.25, 0.2);
}