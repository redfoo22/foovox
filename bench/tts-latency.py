import time, numpy as np
t0=time.time()
from kokoro_onnx import Kokoro
k = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
print(f"model load        : {(time.time()-t0)*1000:.0f} ms")

# warm the graph (first call pays one-time allocation)
k.create("Warming up.", voice="af_heart", speed=1.0, lang="en-us")

tests = [
 ("short",  "Yeah, I can hear you."),
 ("medium", "I checked the tunnel and it is up, so you should be able to reach it from your phone now."),
]
for name, text in tests:
    ts=[]
    for _ in range(3):
        t=time.time(); s,sr = k.create(text, voice="af_heart", speed=1.0, lang="en-us"); ts.append((time.time()-t)*1000)
    best=min(ts); dur=len(s)/sr*1000
    print(f"{name:7s} : synth {best:6.0f} ms | audio {dur:6.0f} ms | realtime x{dur/best:.1f}  \"{text[:40]}...\"")

import soundfile as sf
s,sr = k.create("Hey Redfoo, this is Foovox running on the Windows machine. Voice round trip works.", voice="af_heart", speed=1.0, lang="en-us")
sf.write("sample.wav", s, sr)
print(f"wrote sample.wav ({len(s)/sr:.1f}s @ {sr} Hz)")
