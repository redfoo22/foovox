# Troubleshooting

Start with `foovox doctor`. It names the problem and the command that fixes it.

## The microphone never activates

Almost always a secure-context problem. Browsers refuse `getUserMedia` unless
the page is on HTTPS or localhost.

- `https://...ts.net` (Tailscale) — works
- `https://...trycloudflare.com` — works
- `http://localhost:3210` — works on that machine only
- `http://192.168.1.50:3210` — **loads the page, never gives you a mic**

Use `foovox serve tailscale`.

On iOS the AudioContext also needs a user gesture: audio stays silent until you
tap **Talk** once. That is Safari, not a bug here.

## It interrupts itself

The phone is hearing its own speaker. In order:

1. **Use headphones.** Removes the echo path entirely.
2. **Turn off "Let me talk over it"** in the menu. Strictly take-turns, and it
   is deaf while speaking rather than merely not interrupting.
3. **Calibrate**, then watch the meter above the Talk button while it speaks.
   If the bar crosses the line when only Claude is talking, raise sensitivity.

## It cuts me off mid-sentence

Raise **Silence before it answers**. The default 800 ms is tuned so a pause at
a comma does not end your turn; a slower speaker may want 1000–1200 ms.

## Background noise starts a turn

Talk to it for a few seconds first. It learns where *your* voice sits and puts
the bar below that — the menu shows **room** and **your voice** as separate
numbers, and until it says "learning…" it has nothing to aim at.

Then raise **Bar between room and you**. At 35% the bar sits about a third of
the way from the room to your voice; at 70% it sits well clear of anything in
the background, at the cost of having to speak up.

**Calibrate** on top of that if the room is loud: three seconds of deliberate
silence raises the floor the bar is measured from.

## A dispatched job says it finished but wrote nothing

Check the working directory. Jobs may only write inside it, and a job that
invents an absolute path elsewhere has its write correctly refused.

```bash
FOOVOX_WORK_DIR=/path/to/project foovox restart
```

## There is a long silence before it answers

If it goes quiet for more than a couple of seconds with nothing said, check the
menu — a tool call should announce itself ("let me check that"). If a tool is
running, the wait is real work and the length depends on the tool.

The fixed costs per turn are roughly: the endpoint wait you set on the slider,
about a second of transcription, about a second for the model to start, and
half a second to synthesise the first words. Lowering **Silence before it
answers** is the only one of those you control directly.

## Replies take ten seconds

If it is only slow over a tunnel, check `ffmpeg` is installed — without it
audio falls back to raw PCM, which is 16x larger and can arrive slower than it
can be spoken.

`foovox doctor` checks for it.

## The first turn works and every one after is cut short

You are on an old build. Reopen the app fully (swipe it closed on iOS) so the
service worker picks up the new version.

## Port already in use

```bash
FOOVOX_PORT=3310 FOOVOX_SPEECH_PORT=3311 foovox start
```

## Speech service will not start

It loads two models and needs about 2 GB of RAM. Check `data/pm2-speech.err`
or run it in the foreground:

```bash
venv/bin/python speech_service.py
```
