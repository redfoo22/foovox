/**
 * What does it actually say out loud?
 *
 * The transcript and the speech channel are different things, and only one of
 * them is audible. Reading the code cannot answer "how does it pronounce
 * $67,432.18" — the synthesiser has its own opinions about symbols and digits,
 * and they are not written down anywhere.
 *
 * So this closes the loop: run the text through the speech filter, synthesise
 * it, and transcribe the audio back. Whatever Whisper hears is, near enough,
 * what a person hears. Nothing here is a mock.
 *
 *   npm run say -- "Bitcoin is at $67,432.18"
 */

import { speakable } from '../server/speech-text.mjs';

const SPEECH = process.env.FOOVOX_SPEECH ?? 'http://127.0.0.1:3211';

const CASES = process.argv.slice(2).length ? [process.argv.slice(2).join(' ')] : [
  'It costs $10.',
  'Bitcoin is trading at $67,432.18 right now.',
  'The fee is $1.50 and the total is $2,499.',
  'Revenue was $1.2 million last year.',
  'That is 45% of 1,200 users.',
  'It went from $0.99 to $12 in 3 days.',
];

/** 24 kHz mono float32 out of Kokoro, 16 kHz mono float32 into Whisper. */
function resample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const at = i * ratio;
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, input.length - 1);
    out[i] = input[lo] + (input[hi] - input[lo]) * (at - lo);
  }
  return out;
}

async function say(text) {
  const res = await fetch(`${SPEECH}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: 'af_heart', format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function hear(samples24k) {
  const at16k = resample(samples24k, 24000, 16000);
  const res = await fetch(`${SPEECH}/stt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(at16k.buffer, at16k.byteOffset, at16k.byteLength),
  });
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  return (await res.json()).text.trim();
}

for (const source of CASES) {
  const filtered = speakable(source);
  const heard = await hear(await say(filtered));
  console.log(`\n  written  ${source}`);
  if (filtered !== source) console.log(`  spoken   ${filtered}`);
  console.log(`  heard    ${heard}`);
}
console.log();
