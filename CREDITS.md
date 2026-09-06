# Credits

## The idea

[Frank Gibbs](https://github.com/frankgibbs) asked for voice mode in Claude
Code with access to his own machine — local APIs, local servers, docker hosts —
so he could talk through architecture after stepping away from the keyboard.

Then he built it: [algolearn-speak](https://github.com/frankgibbs/algolearn-speak),
an MCP server giving Claude an ear and a voice through **the host machine's**
speakers and microphone. Kokoro for speech, Whisper for transcription, Silero
for end-of-speech, all on Apple Silicon via MLX, nothing leaving the machine.
257 lines, MIT, and cleanly written — a single audio lock so speak and listen
cannot overlap, VAD pre-roll so the first consonant is not clipped, engine
load failures raised into every tool call rather than swallowed.

Foovox is the phone-shaped version. The audio is captured and played **on the
phone**, not the host, which makes it a different program: different transport,
different runtime, works from anywhere. His solves talking to Claude at your
desk. If that is what you want, use his — it is simpler and it is very good.

Two of his design decisions are used directly here:

- **Voice-activity detection for end-of-speech**, rather than push-to-talk.
  Holding a button to talk to something conversational is the wrong shape.
- **A distinct audio cue per state**, so you know whether it is listening,
  thinking or speaking without looking at the screen.

## Built on

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) — the voice, via
  [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — the ear
- [Claude Code](https://claude.com/claude-code) — the thinking
- [Tailscale](https://tailscale.com) — how your phone reaches your machine
  without anything being public
