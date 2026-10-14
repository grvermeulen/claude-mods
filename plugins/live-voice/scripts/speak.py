"""The voice of the live-voice Claude Code mod with OpenAI.

Reads text from standard input, asks OpenAI's speech API for it as raw 24 kHz
PCM, and plays it while it streams in. It stops as soon as the control file
holds "hush" or "stop". The key comes from OPENAI_API_KEY (or CHATGPT_API_KEY);
OPENAI_BASE_URL points it elsewhere, as OpenAI's own SDKs read it.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

RATE = 24000
CHUNK = 4800  # 100 ms of 16-bit mono

INSTRUCTIONS = {
    "nl": "Spreek natuurlijk Nederlands, warm en rustig, zoals in een gesprek tussen collega's.",
    "en": "Speak naturally, warm and calm, like a conversation between colleagues.",
}


def read_control(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def api_error(err):
    try:
        return json.loads(err.read().decode("utf-8"))["error"]["message"]
    except Exception:
        return err.reason


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--voice", default="marin")
    p.add_argument("--model", default="gpt-4o-mini-tts")
    p.add_argument("--language", default="nl", help="picks the speaking style")
    p.add_argument("--control", help="stop as soon as this file holds hush or stop")
    p.add_argument("--device", help="output device: its index or part of its name; absent, the default")
    p.add_argument("--out", help="write the raw PCM to this file instead of playing it (a test)")
    a = p.parse_args()

    sys.stdin.reconfigure(encoding="utf-8")
    text = sys.stdin.read().strip()
    if not text:
        return 0
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("CHATGPT_API_KEY")
    if not key:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 1

    body = {"model": a.model, "input": text, "voice": a.voice, "response_format": "pcm"}
    instructions = INSTRUCTIONS.get(a.language.split("-")[0])
    if instructions and a.model.startswith("gpt-"):
        body["instructions"] = instructions
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    request = urllib.request.Request(f"{base}/audio/speech", data=json.dumps(body).encode("utf-8"), method="POST",
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as err:
        print(f"OpenAI speech failed ({err.code}): {api_error(err)}", file=sys.stderr)
        return 1
    except OSError as err:
        print(f"OpenAI speech failed: {err}", file=sys.stderr)
        return 1

    with response:
        if a.out:
            with open(a.out, "wb") as f:
                f.write(response.read())
            return 0

        import sounddevice as sd

        device = int(a.device) if a.device and a.device.isdigit() else a.device
        stream = sd.RawOutputStream(samplerate=RATE, channels=1, dtype="int16", device=device)
        stream.start()
        rest, checked = b"", 0.0
        try:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                data = rest + chunk
                even = len(data) - len(data) % 2
                stream.write(data[:even])  # blocks while the device buffer is full, so this paces playback
                rest = data[even:]
                now = time.monotonic()
                if a.control and now - checked > 0.1:
                    checked = now
                    if read_control(a.control) in ("hush", "stop"):
                        stream.abort()
                        return 0
            stream.stop()  # lets what is buffered finish playing
        finally:
            stream.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
