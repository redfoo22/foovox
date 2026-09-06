"""Foovox speech service — STT and TTS, both models held warm, loopback only.

Runs on 127.0.0.1:3211. Deliberately CPU-only: this machine's GPU is shared
with Foolonious (a resident 27B), camwatch and ComfyUI, and under that
contention GPU whisper went from 3.1s to 47.9s on an identical 3-second clip.
CPU is slower in isolation and dramatically more predictable in practice, and
it means a fork of this project needs no GPU at all.

No authentication, by design, and therefore **loopback only, forever**. It
accepts raw audio and returns text; on an interface it would be an open
transcription endpoint. The Node server on 3210 decides who may talk to it.

    POST /stt   body: raw 16kHz mono float32 PCM   -> {"text": "...", "ms": n}
    POST /tts   body: {"text": "...", "voice": "af_heart"}
                                                   -> raw 24kHz mono float32 PCM
    GET  /health                                   -> {"ok": true, ...}
"""

import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HOST = "127.0.0.1"
PORT = int(os.environ.get("FOOVOX_SPEECH_PORT", "3211"))
HERE = os.path.dirname(os.path.abspath(__file__))

# small.en over base.en: base is ~500ms faster but misheard "mutex" as "mute X".
# The LLM does paper over transcription errors, but that is luck, not a design.
STT_MODEL = os.environ.get("FOOVOX_STT_MODEL", "small.en")
VOICE = os.environ.get("FOOVOX_VOICE", "af_heart")
MIC_RATE = 16_000
TTS_RATE = 24_000

print(f"[speech] loading {STT_MODEL} + kokoro...", file=sys.stderr, flush=True)
t0 = time.time()

from faster_whisper import WhisperModel  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402

stt = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", cpu_threads=8)
tts = Kokoro(os.path.join(HERE, "models", "kokoro-v1.0.onnx"),
             os.path.join(HERE, "models", "voices-v1.0.bin"))

# Warm both graphs so the first real request does not pay the allocation.
stt.transcribe(np.zeros(MIC_RATE, dtype=np.float32), beam_size=1, language="en")
list(tts.create("Ready.", voice=VOICE, lang="en-us"))
print(f"[speech] warm in {time.time()-t0:.1f}s", file=sys.stderr, flush=True)


def speakable(text):
    """Normalise for the voice. Dashes become pauses, not mispronounced glyphs."""
    return (text.replace("—", ", ").replace("–", ", ")
                .replace("’", "'").replace("“", "").replace("”", ""))


def to_mp3(samples: np.ndarray) -> bytes:
    """Compress before it goes near a network.

    Raw 32-bit float at 24 kHz is 96 KB per second of speech. Over a Cloudflare
    quick tunnel, measured at roughly 50 KB/s, that is slower than realtime —
    an eight-second reply was 808 KB and took twelve seconds to arrive, so
    playback could never catch up no matter how fast the model was.

    MP3 at 48 kbps is 6 KB/s, a 16x reduction, and puts audio transfer well
    under the time it takes to speak it. Opus would be smaller again, but
    `decodeAudioData` has handled MP3 on every browser for a decade and the
    target here is an iPhone that cannot be tested from this machine. A few
    milliseconds of encoder padding between chunks is inaudible; the chunks
    are separate sentences with natural pauses.
    """
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "quiet",
         "-f", "f32le", "-ar", str(TTS_RATE), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1"],
        input=np.asarray(samples, dtype=np.float32).tobytes(),
        capture_output=True, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"mp3 encode failed (rc={proc.returncode})")
    return proc.stdout


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload, ctype="application/json"):
        body = json.dumps(payload).encode() if ctype == "application/json" else payload
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        return self._send(200, {"ok": True, "stt": STT_MODEL, "voice": VOICE,
                                "device": "cpu", "mic_rate": MIC_RATE, "tts_rate": TTS_RATE})

    def do_POST(self):
        if self.path == "/stt":
            raw = self._body()
            if not raw:
                return self._send(400, {"error": "empty body"})
            audio = np.frombuffer(raw, dtype=np.float32)
            t = time.time()
            segs, _ = stt.transcribe(audio, beam_size=1, language="en")
            text = "".join(s.text for s in segs).strip()
            return self._send(200, {"text": text, "ms": round((time.time() - t) * 1000),
                                    "seconds": round(len(audio) / MIC_RATE, 2)})

        if self.path == "/tts":
            try:
                body = json.loads(self._body() or b"{}")
            except Exception:
                return self._send(400, {"error": "bad json"})
            text = speakable(str(body.get("text") or "")).strip()
            if not text:
                return self._send(400, {"error": "empty text"})
            t = time.time()
            samples, _sr = tts.create(text, voice=str(body.get("voice") or VOICE),
                                      speed=float(body.get("speed") or 1.0), lang="en-us")
            synth_ms = round((time.time() - t) * 1000)
            # `pcm` stays available for the Node test harness, which has no
            # audio decoder; browsers always take mp3.
            want_pcm = str(body.get("format") or "mp3") == "pcm"
            t = time.time()
            audio = (np.asarray(samples, dtype=np.float32).tobytes() if want_pcm
                     else to_mp3(samples))
            self.send_response(200)
            self.send_header("Content-Type",
                             "application/octet-stream" if want_pcm else "audio/mpeg")
            self.send_header("X-Synth-Ms", str(synth_ms))
            self.send_header("X-Encode-Ms", str(round((time.time() - t) * 1000)))
            self.send_header("X-Audio-Ms", str(round(len(samples) / TTS_RATE * 1000)))
            self.send_header("X-Format", "pcm" if want_pcm else "mp3")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            return

        return self._send(404, {"error": "not found"})

    def log_message(self, *_args):
        pass  # stdout stays quiet; errors go to stderr via the server


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[speech] listening on http://{HOST}:{PORT}", file=sys.stderr, flush=True)
    srv.serve_forever()
