# Foovox

Talk to Claude Code out loud, from your phone, anywhere — while it runs on the
machine at home with your projects on it.

Your phone captures the audio and plays the reply. Speech recognition and
speech synthesis run locally on your own machine. The only thing that leaves
it is what Claude Code would send anyway.

```
  iPhone / Android (PWA)                Your machine
  ┌──────────────────┐                 ┌─────────────────────────────┐
  │ mic ──▶ endpoint │   PCM (wss)     │ whisper ──▶ claude ──▶ kokoro│
  │        detection │────────────────▶│   local      warm      local │
  │ speaker ◀── mp3  │◀────────────────│                              │
  └──────────────────┘                 └─────────────────────────────┘
        Tailscale, or a Cloudflare tunnel. No open ports either way.
```

---

## Install

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/redfoo22/foovox/main/install.sh | bash
foovox setup
```

**Windows**

```powershell
irm https://raw.githubusercontent.com/redfoo22/foovox/main/install.ps1 | iex
foovox setup
```

`setup` checks your machine, starts the services, exposes it, and prints
pairing codes. Open one on your phone and **Share → Add to Home Screen**.

You need [Claude Code](https://claude.com/claude-code) installed and signed in
first. The installer checks, but deliberately does not sign you in for you.

### Installing it with an agent

Point your coding agent at this repo and it will find **[AGENTS.md](AGENTS.md)**,
which is written for that: exact commands, what each one should print, and the
two places it must stop and ask you rather than decide for itself — signing in
to Claude Code, and choosing how the server gets exposed.

> Install Foovox from https://github.com/redfoo22/foovox — follow AGENTS.md.

### What it downloads

About 350 MB of speech models on first run: Kokoro for the voice, Whisper for
the ear. After that it works with no speech API and no per-word billing.

---

## Using it

Tap **Talk** and speak. It answers out loud. That is the whole thing.

The button has a second mode, and in a noisy room it is the better one:

| | |
|---|---|
| **Tap** | Hands-free. It works out when you have finished, answers, and keeps listening. Tap again to stop. |
| **Hold** | Push to talk. It records while your thumb is down and sends the instant you lift it, then goes quiet. |

Hold is worth knowing about. Hands-free has to decide whether a sound is you or
the room, and that decision is a guess — it is what makes voice assistants cut
you off mid-sentence, or answer someone else talking nearby. While the button is
held there is no guess: every frame is your speech, no threshold is consulted,
and nothing ends the turn but your thumb. On a bus, on speakerphone, or with
other people in the room, hold it. It is also slightly faster, because there is
no silence timer to wait out.

Both work from the keyboard too — tap Enter, or hold Space.

| | |
|---|---|
| **Model** | Sonnet, Opus, Fable or Haiku, per session, switchable mid-conversation |
| **Sessions** | The left rail. Each is a separate warm conversation |
| **"How's it going"** | Spoken status of everything running |
| **"Code it in Opus"** | Hands the conversation to a background job |
| **Calibrate** | Three seconds of silence to learn your room |

### Dispatching work

A voice turn is one exchange. A build takes minutes and many tool calls, so it
does not belong inside one.

Talk through what you want, then say **"code it in Opus"**. The voice session
writes a brief from the conversation, a separate session picks it up with
tools armed, and you carry on talking. Ask **"how's it going"** any time.

The brief matters. "Code it in Opus" is a pronoun — the task lives in the
conversation, which the job has never seen. So the conversation is turned into
a self-contained brief first. Without that, the job receives the phrase rather
than the task.

---

## Permissions

Default is **Chat**: it cannot read, write or run anything. Raise it per
session in the menu.

| Tier | What it can do |
|---|---|
| **Chat** | Talk. Nothing else. |
| **Read** | Read files, search the web. Changes nothing. |
| **Build** | Create and edit files **inside its working directory**. |
| **Full** | Everything, including shell commands. |

Dispatched jobs get **Build**, not Full — a job that needs to save a file does
not need a shell.

Tiers are allow-lists, not deny-lists, and the tool list is read from the CLI
at runtime. That is deliberate: a deny-list permits anything it has not heard
of, and an early version denied `Bash` while the machine also had `PowerShell`,
which left a shell open on the tier documented as having none.

Run `npm run verify:tiers` to check every tier against the real CLI on your
own machine.

**Understand what Full means.** It can run any command your user account can:
install things, delete things, read your credentials, reach the network. A
pairing code inherits whatever tier the session is on. Only grant it on a
machine where that is genuinely acceptable.

---

## Getting to it from your phone

### Tailscale — recommended

```bash
foovox serve tailscale
```

Your phone reaches your machine over your own private network. **There is no
public URL.** Nothing is exposed to the internet, so there is nothing to find,
scan or brute force.

It also solves a problem the alternatives do not: browsers refuse to hand over
a microphone except in a secure context, and Tailscale supplies real HTTPS on
your `*.ts.net` name via `tailscale serve`. Plain `http://192.168.x.x` will
load the page and then never give you a microphone.

Install Tailscale on both the machine and the phone, sign both into the same
tailnet, and that is it.

### Cloudflare tunnel

```bash
foovox serve cloudflare
```

A public HTTPS URL. Use this if you cannot put Tailscale on the phone, or you
want to give someone outside your tailnet access.

**It is a public URL.** Anyone who has it reaches your sign-in page, and the
pairing code is the only lock. That is a real lock — one-use, rate limited —
but it is one lock instead of two. For a permanent address, put a named tunnel
on a domain you own and Cloudflare Access in front of it.

Quick tunnels get a new random URL every restart, and Access cannot be applied
to them, because policies attach to hostnames in your own Cloudflare zone and
`trycloudflare.com` is not one.

### Local

```bash
foovox serve local
```

This machine only. Fine for development; a phone on your LAN cannot use the
microphone over plain HTTP.

---

## Commands

```
foovox setup                first run: check, start, expose, print codes
foovox status               what is running and where it is reachable
foovox doctor               check the machine and say what is missing
foovox pair --count 10      mint pairing codes
foovox serve <mode>         tailscale | cloudflare | local | off
foovox start | stop         run or stop the local services
```

Pairing codes are one-use and default to a 7-day expiry. Mint ten, keep them
somewhere safe, use them as you need — each one is a key to this machine.

---

## How it works, and why

Most of these decisions came from something failing on a real phone.

### Latency

Measured, warm, time to first token:

| | |
|---|---|
| Sonnet 5 | 833 ms |
| Opus 5 | 891 ms |
| Haiku 4.5 | 1303 ms |
| Fable 5 | 2647 ms |

Mouth shut to first audio is about **2.5–4 seconds**. Opus costs ~60 ms over
Sonnet, so use the smarter model.

**One process per session, kept warm.** Spawning `claude -p` per message costs
6305 ms to first token. Holding one open on `--input-format stream-json` costs
1011 ms. That 5.3 seconds a turn is the difference between a conversation and
a voicemail.

**It speaks the first clause, not the first sentence.** Waiting for a complete
sentence meant synthesising 8.7 seconds of audio before a single word came
out — 1768 ms. Capped at a natural break inside 12 words it is 504 ms.

**Tokens become speech as they arrive.** Nothing waits for the reply to
finish: the first clause is synthesised while the model is still writing the
second, and each chunk is scheduled to play as the one before it ends.

**Transcription starts before you have finished.** The endpoint deliberately
waits 800 ms of silence to be sure you are done, and that wait used to be dead
air with a second of speech-to-text queued behind it. The client now says
"probably finished" after 250 ms of quiet and the server starts work then — a
550 ms head start on every turn. If you carry on talking, the guess is
discarded, which costs nothing.

**It says something while a tool runs.** A tool call has no upper bound: a
file read is instant, a web search is seconds, a shell command was measured at
42. Rather than go silent it says "let me check that" — a different line each
time, never the same one twice running, and only once per turn however many
tools it uses.

**Audio is mp3.** Raw 32-bit float at 24 kHz is 96 KB per second of speech. An
eight-second reply was 808 KB and took twelve seconds to arrive over a tunnel —
slower than realtime, so playback could never catch up. At 48 kbps it is 16x
smaller, encoded in 72 ms.

### Speech runs on CPU on purpose

GPU Whisper went from 3.1 s to **47.9 s** on an identical clip when a large
model was resident on the same card. CPU is slower in isolation and
dramatically more predictable in practice — and it means you do not need a GPU
at all.

### Hearing you over itself

On speakerphone the microphone hears the loudspeaker. Left alone, the endpoint
detector hears Claude, treats it as you interrupting, transcribes Claude's own
sentence and asks Claude about it. A feedback loop that sounds like *"choppy,
and I could not get a word in"*.

Two obvious fixes are worse than they look:

- **Matching the transcript** needs a full speech-to-text pass — about a
  second — before it can decide, and has nothing to compare against when you
  cut in mid-word.
- **A high-frequency watermark** cannot survive this pipeline: the microphone
  is downsampled to 16 kHz for Whisper, so by Nyquist nothing above 8 kHz
  exists to detect. Below that, phone noise suppression removes it.

Neither is needed, because **the exact samples being played are already in
hand**. Their loudness envelope is recorded against the audio clock and the
microphone is judged against what the speaker is known to be emitting right
then.

**The gaps are the mechanism.** Speech is silent between every word, and
energy heard in a gap cannot be echo — so an interruption is caught at full
sensitivity within one frame, with no added latency.

Two things this got wrong first, both worth knowing if you touch it:

1. A 180 ms window was used to cover an unknown speaker-to-mic delay. Gaps
   between words are 50–200 ms, so the window smeared across them and erased
   the entire mechanism. The delay is now *measured* by correlation.
2. The echo-coupling estimate was an average, and a person talking over the
   reply taught it the echo was enormous — after which they were never heard
   again. It now tracks the **minimum** ratio: a person can only ever add
   energy to a microphone, never remove it.

The opening 700 ms of every reply is a measurement period rather than a
decision, because at that instant the delay has not been measured yet — and a
wrong delay makes Claude's own first word look like an interruption.

### Your room, and your voice

It learns **two** levels, not one: how loud the room is when nobody is
talking, and how loud **you** are when you are. The trigger sits between them.

```
   quiet room ──────────── bar ──────────── your voice
                          ▲
                   the slider moves this
```

That second level is the important one, and it came from a real complaint:

> *"when I'm talking it sets it right — and if it would just stay up there it
> wouldn't pick up the noise when I stop. But it goes right back down."*

Exactly so. The old version tracked only a noise floor, on a 400 ms average,
so half a second after your last word the bar had settled back onto room noise
and someone talking across the room could clear it. Your voice level decays
over about a minute instead, so the bar stays where your speech put it while
you pause to think.

The slider is **where the bar sits between the two**, 5% to 90%. Low is
twitchy; high ignores more background but makes you speak up.

It used to be a multiplier on the noise floor — `max(floor * sensitivity,
0.008)` — and in a quiet room a floor of ~0.001 meant every slider position
landed under that fixed minimum and produced an identical threshold. The
control was inert across nearly its whole travel. It now spans about 10x, and
`npm run levels` checks that in a real browser.

**Calibrate** still helps in a loud room: three seconds of deliberate silence,
using the **90th percentile** rather than the mean, because the mean of a room
with surf in it sits far below the crash that actually triggers a turn. It
raises the floor and never lowers it.

The meter above the Talk button shows your level in dBFS with the bar drawn on
it, and the menu shows the room level and your learned voice level separately.

---

## Credit

The idea came from [Frank Gibbs](https://github.com/frankgibbs), who wanted
voice mode for Claude Code with access to his own machine, and built
[algolearn-speak](https://github.com/frankgibbs/algolearn-speak) — an MCP
server giving Claude an ear and a voice through **the host machine's** speakers
and microphone, on Apple Silicon via MLX.

Foovox is the phone-shaped version of the same idea. Different transport,
different runtime, same goal: his is a desk tool, this is a pocket one. Two
design details are taken directly from his work — using voice-activity
detection for end-of-speech rather than push-to-talk, and giving each state a
distinct audio cue. If you are on a Mac and want to talk to Claude at your
desk, use his; it is simpler and it is very good.

---

## Requirements

- Node 20+, Python 3.10+, ffmpeg
- [Claude Code](https://claude.com/claude-code), signed in
- ~350 MB for speech models, ~2 GB RAM while running
- **No GPU required**

Works on macOS, Linux and Windows.

## License

MIT.
