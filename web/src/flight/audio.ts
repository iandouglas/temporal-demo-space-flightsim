/** Tiny WebAudio synth: no audio files to ship or license. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  muted = false;

  constructor() {
    try { this.muted = localStorage.getItem('flight.muted') === '1'; } catch { /* storage unavailable */ }
  }

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try { localStorage.setItem('flight.muted', this.muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, slideTo?: number, delay = 0): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, from: number, to: number, delay = 0): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t);
  }

  /** Blaster zap: fast downward chirp. */
  laser(): void { this.tone(1400, 0.09, 'sawtooth', 0.07, 320); }
  /** Something blew up; enemies get a bigger, lower boom. */
  boom(big: boolean): void { this.noise(big ? 0.9 : 0.45, big ? 0.8 : 0.45, big ? 900 : 1600, 60); if (big) this.tone(70, 0.6, 'sine', 0.4, 30); }
  klaxon(): void { for (let i = 0; i < 3; i++) { this.tone(620, 0.22, 'square', 0.12, undefined, i * 0.36); this.tone(460, 0.16, 'square', 0.12, undefined, i * 0.36 + 0.18); } }
  hit(big = false): void { this.noise(big ? 0.7 : 0.35, big ? 0.9 : 0.6, 1400, 90); this.tone(90, 0.3, 'sine', 0.4, 40); }
  alarm(): void { this.tone(880, 0.12, 'square', 0.08); this.tone(660, 0.12, 'square', 0.08, undefined, 0.12); }
  /** Rising pitch per repair tap so each tap is audibly progress. */
  tap(step = 1): void { this.tone(440 + step * 140, 0.09, 'triangle', 0.22); }
  repaired(): void { [660, 880, 1320].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.18, undefined, i * 0.06)); }
  ring(): void { this.tone(988, 0.25, 'sine', 0.2, 1976); }
  charge(): void { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.16, undefined, i * 0.08)); }
  beep(high = false): void { this.tone(high ? 1320 : 660, high ? 0.5 : 0.18, 'sine', 0.25); }
  whoosh(): void {
    this.noise(1.6, 0.7, 200, 6000);
    [261.6, 329.6, 392, 523.3].forEach((f) => this.tone(f, 1.8, 'sawtooth', 0.05, f * 2));
  }
}
