// The master bus's last stage: a gentle soft clip, then a look-ahead peak limiter that keeps every sample under the
// ceiling. Pure code shared by the master worklet and the tests.

export const MASTER_PROCESSOR_NAME = "morsel-master";

/** Output ceiling, −0.3 dBFS. */
export const CEILING = Math.pow(10, -0.3 / 20);
const LOOKAHEAD = 0.003; // seconds
const RELEASE = 0.08; // seconds, to recover about 63% of the way
/** Soft clip knee: samples under −3 dBFS pass untouched. */
const KNEE = 0.7;

/** Unity below the knee, then bends smoothly towards ±1 (it never reaches it). */
export function softClip(x: number) {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const y = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
  return x < 0 ? -y : y;
}

/** What the master processor reports for the meter: the output peak and the deepest gain reduction (1 = none). */
export interface MasterMeter {
  peak: number;
  gain: number;
}

/**
 * Look-ahead limiter. Each sample's needed gain (ceiling / |peak|) is held over the look-ahead window, released
 * smoothly, and then averaged over the same window: the gain glides down over the window and is at or below what a
 * peak needs by the time that peak comes out, which is `latency` samples late.
 */
export class MasterCore {
  readonly latency: number;
  private n: number;
  /** Delayed input, per channel. */
  private delay: Float32Array[];
  /** Needed gains of the window (for the running minimum), and the released minimums (for the average). */
  private need: Float32Array;
  private held: Float64Array;
  /** Monotonic queue of indices into `need` (their values rise from head to tail): the window's minimum at the head. */
  private queue: Int32Array;
  private qHead = 0;
  private qLen = 0;
  private pos = 0;
  private sum: number;
  private released = 1;
  private releaseCoef: number;
  private meter: MasterMeter = { peak: 0, gain: 1 };

  constructor(sampleRate: number, channels = 2) {
    this.n = Math.max(1, Math.round(LOOKAHEAD * sampleRate));
    this.latency = this.n - 1;
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.n));
    this.need = new Float32Array(this.n).fill(1);
    this.held = new Float64Array(this.n).fill(1);
    this.queue = new Int32Array(this.n);
    this.sum = this.n;
    this.releaseCoef = 1 - Math.exp(-1 / (RELEASE * sampleRate));
  }

  /** Limit `n` frames of `input` into `output` (same channel count; they may be the same arrays). */
  process(input: Float32Array[], output: Float32Array[], frames: number) {
    const { n, need, held, queue, delay } = this;
    const chans = delay.length;
    for (let i = 0; i < frames; i++) {
      const p = this.pos;
      // The needed gain of the newest sample, after the soft clip.
      let peak = 0;
      for (let c = 0; c < chans; c++) {
        const x = softClip(input[c]?.[i] ?? 0);
        delay[c][p] = x;
        const a = Math.abs(x);
        if (a > peak) peak = a;
      }
      const g = peak > CEILING ? CEILING / peak : 1;
      // Running minimum over the last n needed gains.
      if (this.qLen && queue[this.qHead] === p) {
        this.qHead = (this.qHead + 1) % n;
        this.qLen--;
      }
      while (this.qLen && need[queue[(this.qHead + this.qLen - 1) % n]] >= g) this.qLen--;
      need[p] = g;
      queue[(this.qHead + this.qLen) % n] = p;
      this.qLen++;
      const min = need[queue[this.qHead]];
      // Release towards 1, never above what the window needs.
      this.released = Math.min(min, this.released + (1 - this.released) * this.releaseCoef);
      this.sum += this.released - held[p];
      held[p] = this.released;
      const gain = Math.min(1, this.sum / n);
      this.pos = (p + 1) % n;
      // The oldest sample of the window comes out now: the one at the new write position.
      for (let c = 0; c < chans; c++) {
        let y = delay[c][this.pos] * gain;
        if (y > CEILING) y = CEILING;
        else if (y < -CEILING) y = -CEILING;
        output[c][i] = y;
        const a = Math.abs(y);
        if (a > this.meter.peak) this.meter.peak = a;
      }
      if (gain < this.meter.gain) this.meter.gain = gain;
    }
  }

  /** The meter since the last call. */
  takeMeter(): MasterMeter {
    const m = this.meter;
    this.meter = { peak: 0, gain: 1 };
    return m;
  }
}
