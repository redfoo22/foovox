import json, os, subprocess, time
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
from faster_whisper import WhisperModel
CLAUDE = os.path.expanduser(r"~\.local\bin\claude.exe")
k = Kokoro("models/kokoro-v1.0.onnx","models/voices-v1.0.bin"); k.create("warm",voice="af_heart",lang="en-us")
w = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=8)

Q = "Hey Claudio, we're testing the voice pipeline. Can you hear me okay, and how fast did that come back?"
q,sr = k.create(Q, voice="am_michael", lang="en-us"); sf.write("q.wav", q, sr)
t=time.time(); segs,_ = w.transcribe("q.wav", beam_size=1, language="en")
heard="".join(x.text for x in segs).strip(); stt=(time.time()-t)*1000

p = subprocess.Popen([CLAUDE,"-p","--input-format","stream-json","--output-format","stream-json",
  "--verbose","--model","claude-sonnet-5","--append-system-prompt",
  "You are Claudio, a voice assistant on Redfoo's phone. Answer in two short spoken sentences. "
  "Plain speech: no markdown, no lists. You are being tested over a voice pipeline."],
  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
def ask(text):
    t=time.time(); p.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}})+"\n"); p.stdin.flush()
    for line in p.stdout:
        if not line.strip(): continue
        try: j=json.loads(line)
        except: continue
        if j.get("type")=="result": return (j.get("result") or "").strip(), (time.time()-t)*1000
ask("hi")
reply, llm = ask(heard + f" (For reference: speech-to-text took {stt:.0f} milliseconds.)")
print(f"heard: {heard}\nstt: {stt:.0f} ms | llm: {llm:.0f} ms\nreply: {reply}")

sp = lambda s: s.replace("—",", ").replace("–",", ").replace("’","'")
a,sr2 = k.create(sp(reply), voice="af_heart", lang="en-us")
gap = np.zeros(int(sr*0.7), dtype=np.float32)
sf.write("demo.wav", np.concatenate([q, gap, a]), sr)
