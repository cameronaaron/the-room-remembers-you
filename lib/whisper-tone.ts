/**
 * Lighten the recorded voice, rather than synthesize a replacement.
 * A little dry signal keeps low vowels; the high-pass emphasizes breath and
 * consonants. A gentle low-pass reduces harshness. No noise, pitch shift,
 * reversed envelope, or time stretch is introduced.
 */
export function whisperTone(pcm: Float32Array, sampleRate: number, loss = 0): Float32Array {
  const output = new Float32Array(pcm.length);
  const highpass = Math.exp(-2 * Math.PI * Math.min(280, sampleRate * 0.2) / sampleRate);
  const lowpass = 1 - Math.exp(-2 * Math.PI * Math.min(6500 - Math.max(0, Math.min(1, loss)) * 5300, sampleRate * 0.4) / sampleRate);
  let previous = 0;
  let high = 0;
  let low = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    high = highpass * (high + pcm[i] - previous);
    previous = pcm[i];
    const voice = pcm[i] * 0.18 + high * 0.82;
    low += lowpass * (voice - low);
    output[i] = low;
    peak = Math.max(peak, Math.abs(low));
  }
  // Set a useful level from the spoken portions, without amplifying silence.
  if (peak < 1e-7) return output;
  let energy = 0;
  let count = 0;
  for (const value of output) {
    if (Math.abs(value) < peak * 0.02) continue;
    energy += value * value;
    count++;
  }
  const rms = Math.sqrt(energy / Math.max(1, count));
  const gain = Math.min(100, 0.22 / Math.max(rms, 1e-7), 0.9 / peak);
  for (let i = 0; i < output.length; i++) output[i] *= gain;
  return output;
}
