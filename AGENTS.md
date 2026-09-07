# Installing Foovox — instructions for an agent

You are installing Foovox on the machine you are running on, for the person who
asked you to. Follow this file top to bottom. Everything here has been run on a
real machine; the failure modes described are ones that actually happened, not
hypotheticals.

**Two things you cannot do for them, and must not try.** Both are marked
**STOP** below. Everything else is yours.

---

## 0. What this is, so you can judge whether they want it

Foovox lets someone talk to Claude Code out loud from their phone, while it runs
on this machine with their projects on it. Speech recognition and speech
synthesis run locally. It opens a web server and, usually, a way to reach that
server from their phone.

**It can execute code on this machine.** A session at the highest permission tier
runs any command the user's account can. Anyone holding a pairing code gets
whatever tier the session is set to. Treat a pairing code as you would a shell
credential. If you are operating on a machine that is not the requester's own,
stop and ask.

---

## 1. Check the prerequisites

```bash
node --version      # need 20 or newer
python3 --version   # need 3.10 or newer   (on Windows try: py -3 --version)
ffmpeg -version     # any recent build
git --version
claude --version    # Claude Code
```

Install whatever is missing:

| | macOS | Windows | Debian/Ubuntu |
|---|---|---|---|
| Node 20+ | `brew install node` | `winget install OpenJS.NodeJS.LTS` | `apt install nodejs` |
| Python 3.10+ | `brew install python` | `winget install Python.Python.3.12` | `apt install python3 python3-venv` |
| ffmpeg | `brew install ffmpeg` | `winget install Gyan.FFmpeg` | `apt install ffmpeg` |
| Claude Code | see below | see below | see below |

ffmpeg is **not** optional. Replies are sent to the phone as mp3; without an
encoder every reply is about sixteen times larger and arrives slower than it can
be spoken.

### Windows: `python3` may be a decoy

Windows ships stub executables at `WindowsApps\python3.exe`. They exist, `where
python3` finds them, and running one prints *"Python was not found; run without
arguments to install from the Microsoft Store"* and fails. **Do not conclude
Python is installed because the command resolves.** Run it and read the output.
Prefer `py -3`. The installer now does this itself, but your own checks should
too.

---

## 2. STOP — Claude Code sign-in is theirs, not yours

Foovox drives the `claude` CLI, which must already be signed in. Signing in
opens a browser and binds their account.

**Do not attempt to authenticate, and do not use credentials you find on the
machine.** Ask the person to run this themselves, in their own terminal:

```bash
claude
```

They complete the sign-in once, then tell you to continue. Verify with:

```bash
claude -p "Reply with the single word: ok"
```

If that prints `ok`, they are signed in and you can proceed. If it errors or
prompts, they are not — say so and wait. Do not work around it.

---

## 3. Check the ports before you install

Foovox binds **3210** (server) and **3211** (speech), both on `127.0.0.1`.

```bash
# macOS / Linux
lsof -i :3210 -i :3211
# Windows
netstat -ano | findstr "3210 3211"
```

If either is taken — including by an **existing Foovox instance** — do not
install over it. Pick free ports and set them for every command you run:

```bash
export FOOVOX_PORT=3220
export FOOVOX_SPEECH_PORT=3221
```

A second instance on the default ports will appear to work and then compete for
them, and on some systems the narrower bind silently wins, so health checks pass
while traffic reaches the wrong process.

---

## 4. Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/redfoo22/foovox/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/redfoo22/foovox/main/install.ps1 | iex
```

To install somewhere other than `~/.foovox`, set `FOOVOX_DIR` first.

This clones the repo, installs one npm package, creates a Python virtualenv,
installs the speech packages, and downloads **about 350 MB of models**. Expect
several minutes. It exits non-zero and names the missing piece if it cannot
finish — read that message rather than retrying blindly.

The installer also puts a `foovox` command on their PATH. On Windows that is a
`.cmd` shim in `~/.local/bin`; **if one already exists it will be overwritten**,
so check before installing a second copy.

---

## 5. Verify before exposing anything

```bash
foovox doctor
```

Every line must be a tick. It checks Node, the Claude CLI, whether Claude is
signed in, Python, the virtualenv, the downloaded models, and ffmpeg. If a line
fails it names the exact fix. Do not continue past a failure.

---

## 6. STOP — how it gets to their phone is their decision

`foovox setup` starts the services and then **exposes them**. That last part has
security and privacy consequences, and the default is not always what you want:

| Mode | What it does |
|---|---|
| `tailscale` | Reachable only inside their own tailnet. No public URL. **Recommended.** |
| `cloudflare` | A **public** HTTPS URL. Anyone who has it reaches the sign-in page. |
| `local` | This machine only. A phone cannot use it. |

**`setup` defaults to Tailscale if the binary is present, Cloudflare if not.**
That Cloudflare fallback is a public URL, so never let it happen by accident.

**If Tailscale is already serving something on this machine, `foovox serve
tailscale` takes it over.** On a machine that already runs Foovox, this will
repoint the existing instance's URL at your new one and break it.

Ask which they want. Then:

```bash
foovox setup --serve tailscale     # or: cloudflare, local
```

Testing on a machine that already has an instance:

```bash
FOOVOX_PORT=3220 FOOVOX_SPEECH_PORT=3221 foovox setup --serve local
```

Microphones need a secure context. `local` and plain `http://192.168.x.x` will
load the page and then never grant a microphone. Only Tailscale and Cloudflare
give the real HTTPS a browser requires.

---

## 7. Hand over the pairing code

`setup` prints one-use pairing codes and a link. Give the person the link; they
open it on their phone and choose **Share → Add to Home Screen**.

```bash
foovox pair --count 10 --ttl 30d
```

Each code is a key to this machine. Do not post them anywhere, do not commit
them, and do not put them in a summary that gets stored.

---

## 8. Prove it works, do not assume

```bash
foovox status
npm test                                    # in the install directory
node scripts/test-spoken.mjs read "What is two plus two?"
```

The last one asks the running server a real question and prints three things:
what went to the screen, what went to the speaker, and a transcription of the
audio that came back. If the transcription is a sensible answer, the whole
pipeline works — microphone path aside, which needs a real phone.

Report what these actually printed. Do not report success from an install that
merely exited 0.

---

## 9. Set the permission tier deliberately

Sessions start at **Chat**, which can do nothing but talk. The user raises it in
the app's menu, per session.

| Tier | What it can do |
|---|---|
| Chat | Talk. Nothing else. |
| Read | Read files, search the web. Changes nothing. |
| Build | Create and edit files inside its working directory. |
| Full | Any command the user's account can run. |

Leave it at Chat. Raising it is the user's decision, made knowingly, in the app.

---

## Things that will waste your time if you do not know them

- **`foovox stop` used to leave services running.** Fixed, but if you are on an
  older checkout and stop reports nothing, check the ports directly — a stale
  pid file used to be indistinguishable from a clean shutdown.
- **`data/` holds credentials.** The admin token and hashed device tokens live
  there. It is gitignored. Never commit it, print it, or copy it into a summary.
- **Speech runs on CPU on purpose.** Do not "optimise" it onto a GPU. On a
  machine with a model resident, GPU Whisper went from 3.1 s to 47.9 s on an
  identical clip.
- **macOS is not yet verified end to end.** Everything platform-specific has
  been fixed by inspection and the Windows path is tested from scratch, but if
  you are the first to run this on a Mac, expect to report a problem and please
  open an issue.

## If something fails

`docs/TROUBLESHOOTING.md` covers the common ones. `docs/SECURITY.md` explains
the threat model and what a pairing code actually grants. Report the real error
text to the person — not a paraphrase, and not a guess at the cause.
