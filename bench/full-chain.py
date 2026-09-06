"""Phase 1 final: STT on CPU, warm Claude, word-capped first chunk.

The change from roundtrip2: do not wait for a whole sentence before speaking.
That cost 2 seconds -- the splitter grabbed a 25-word sentence and Kokoro
synthesised 8.7s of audio before a single word came out. The ear only needs
the first few words to start.
"""
import json, os, subprocess, time
import soundfile as sf
from kokoro_onnx import Kokoro
from faster_whisper import WhisperModel

CLAUDE = os.path.expanduser(r"~\.local\bin\claude.exe")

print("loading engines (once, at service start)...")
k = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
k.create("warm", voice="af_heart", lang="en-us")
w = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=8)
list(w.transcribe("user_said.wav", beam_size=1)[0])
print("engines warm.\n")


def speakable(text):
    """Normalise for the voice. Dashes become pauses, not mispronounced glyphs."""
    return text.replace("—", ", ").replace("–", ", ").replace("’", "'")


def first_chunk(buf):
    """Emit at the first natural breath, hard-capped by word count."""
    words = speakable(buf).split()
    if len(words) >= 6:
        for i in range(5, min(len(words), 12)):
            if words[i][-1] in ",;:.!?":
                return " ".join(words[:i + 1])
    if len(words) >= 12:
        return " ".join(words[:12])
    return None


QUESTION = "Hey, what is the difference between a mutex and a semaphore?"
s, sr = k.create(QUESTION, voice="am_michael", lang="en-us")
sf.write("user3.wav", s, sr)
print(f'[mic]    {len(s)/sr:.1f}s  "{QUESTION}"')

t = time.time()
segs, _ = w.transcribe("user3.wav", beam_size=1, language="en")
heard = "".join(x.text for x in segs).strip()
stt = (time.time() - t) * 1000
print(f'[stt]   {stt:6.0f} ms  "{heard}"')

p = subprocess.Popen(
    [CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
     "--include-partial-messages", "--verbose", "--model", "claude-sonnet-5",
     "--append-system-prompt",
     "You are a voice assistant on a phone. Answer from your own knowledge, "
     "conversationally, in two or three short spoken sentences. Plain speech "
     "only: no markdown, no code blocks, no lists."],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)


def ask(text):
    t = time.time()
    ttft = chunk_ms = chunk = None
    buf = ""
    p.stdin.write(json.dumps({"type": "user", "message": {"role": "user",
                  "content": [{"type": "text", "text": text}]}}) + "\n")
    p.stdin.flush()
    for line in p.stdout:
        if not line.strip():
            continue
        try:
            j = json.loads(line)
        except Exception:
            continue
        d = (j.get("event") or {}).get("delta") or j.get("delta") or {}
        if d.get("text"):
            if ttft is None:
                ttft = (time.time() - t) * 1000
            buf += d["text"]
            if chunk is None:
                c = first_chunk(buf)
                if c:
                    chunk, chunk_ms = c, (time.time() - t) * 1000
        if j.get("type") == "result":
            return buf.strip(), ttft, chunk_ms or (time.time() - t) * 1000, chunk or buf, (time.time() - t) * 1000


ask("Say hi.")  # burn the cold turn
reply, ttft, chunk_ms, chunk, full = ask(heard)
print(f"[claude] TTFT {ttft:.0f} ms | first CHUNK {chunk_ms:.0f} ms | full reply {full:.0f} ms")
print(f'[claude] speaks first: "{chunk}"')

t = time.time()
s2, sr2 = k.create(speakable(chunk), voice="af_heart", lang="en-us")
tts = (time.time() - t) * 1000
sf.write("reply3.wav", s2, sr2)
print(f"[tts]   {tts:6.0f} ms for {len(s2)/sr2:.1f}s of audio")

VAD, NET = 600, 100
total = VAD + stt + chunk_ms + tts + NET
print("\n" + "=" * 60)
for lbl, v in [("VAD endpoint (browser)", VAD), ("Whisper base.en (CPU)", stt),
               ("Claude Code -> first chunk", chunk_ms), ("Kokoro first chunk", tts),
               ("Network to Hawaii", NET)]:
    print(f"  {lbl:<32}{v:7.0f} ms")
print(f"  {'MOUTH SHUT -> FIRST AUDIO':<32}{total:7.0f} ms   ({total/1000:.1f}s)")
print("=" * 60)
print(f'\nfull reply: "{reply[:150]}"')
p.kill()
