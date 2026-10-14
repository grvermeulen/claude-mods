"""The ears of the live-voice Claude Code mod.

Listens to the microphone, cuts speech into utterances by loudness, transcribes
each one, and prints one JSON object per line:

  {"type": "ready"}               the transcriber is ready and the microphone open
  {"type": "speech"}              someone started talking
  {"type": "heard"}               an utterance ended and is being transcribed
  {"type": "text", "text": "..."} what was said
  {"type": "ignored"}             the utterance held no words
  {"type": "error", "message": "..."}

--engine openai sends each utterance to OpenAI's transcription API (the key in
OPENAI_API_KEY or CHATGPT_API_KEY; OPENAI_BASE_URL points it elsewhere, as
OpenAI's own SDKs read it); --engine local runs faster-whisper on the CPU.

The control file holds one word: listen, pause or stop. While paused, audio is
thrown away, so the mod can talk without hearing itself; stop ends the process.
"""
import argparse
import io
import json
import os
import queue
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave

import numpy as np

RATE = 16000
FRAME = 480  # 30 ms at 16 kHz

# What speech recognition writes for silence or noise, learned from subtitled video.
HALLUCINATIONS = (
    "ondertiteling",
    "ondertiteld door",
    "bedankt voor het kijken",
    "tv gelderland",
    "thanks for watching",
    "thank you for watching",
    "subtitles by",
    "amara.org",
)


class Fatal(Exception):
    """An error no next utterance will fix, such as a refused API key."""


def emit(kind, **fields):
    sys.stdout.write(json.dumps({"type": kind, **fields}) + "\n")
    sys.stdout.flush()


def read_control(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or "listen"
    except OSError:
        return "listen"


def read_wav(path):
    """A PCM WAV as 16 kHz mono float32, resampled linearly (good enough for speech)."""
    with wave.open(path, "rb") as w:
        width, channels, rate = w.getsampwidth(), w.getnchannels(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"{path}: only 16-bit PCM WAV is read, not {8 * width}-bit")
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != RATE:
        at = np.arange(0, len(audio), rate / RATE)
        audio = np.interp(at, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def to_wav(audio):
    """16 kHz mono float32 as the bytes of a 16-bit WAV file."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes())
    return buffer.getvalue()


def multipart(fields, filename, data):
    """A multipart/form-data body: the text fields, then the WAV as `file`."""
    boundary = "live-voice-" + uuid.uuid4().hex
    body = b""
    for name, value in fields:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
             "Content-Type: audio/wav\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return f"multipart/form-data; boundary={boundary}", body


def api_error(err):
    try:
        return json.loads(err.read().decode("utf-8"))["error"]["message"]
    except Exception:
        return err.reason


def drain(frames):
    while True:
        try:
            frames.get_nowait()
        except queue.Empty:
            return


class Segmenter:
    """Starts an utterance after three loud frames, ends it after `silence_ms` of quiet.

    The noise floor follows the room while nobody talks, so a fan or a hum raises
    the bar instead of keeping an utterance open.
    """

    def __init__(self, silence_ms, min_ms=400, max_ms=30000, preroll_ms=300):
        self.silence_frames = max(1, silence_ms // 30)
        self.min_frames = min_ms // 30
        self.max_frames = max_ms // 30
        self.preroll = preroll_ms // 30
        self.noise = None
        self.reset()

    def reset(self):
        self.frames = []
        self.loud = 0
        self.quiet = 0
        self.active = False

    def threshold(self):
        return max(0.005, (self.noise or 0.002) * 3.0)

    def push(self, frame):
        """Feeds one frame; returns a finished utterance, or None."""
        rms = float(np.sqrt(np.mean(frame * frame)))
        if not self.active:
            floor = min(rms, self.threshold())
            self.noise = floor if self.noise is None else 0.95 * self.noise + 0.05 * floor
            self.frames = (self.frames + [frame])[-(self.preroll + 3):]
            self.loud = self.loud + 1 if rms > self.threshold() else 0
            if self.loud >= 3:
                self.active = True
                self.quiet = 0
            return None
        self.frames.append(frame)
        self.quiet = self.quiet + 1 if rms <= self.threshold() else 0
        if self.quiet < self.silence_frames and len(self.frames) < self.max_frames:
            return None
        spoken = len(self.frames) - self.quiet
        audio = np.concatenate(self.frames)
        self.reset()
        return audio if spoken >= self.min_frames else None


def local_transcriber(a):
    from faster_whisper import WhisperModel

    model = WhisperModel(a.model, device="cpu", compute_type="int8",
                         download_root=a.models, local_files_only=not a.download)
    language = None if a.language == "auto" else a.language

    def transcribe(audio):
        segments, _ = model.transcribe(audio, language=language, beam_size=5,
                                       vad_filter=True, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6)

    return transcribe


def openai_transcriber(a):
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("CHATGPT_API_KEY")
    if not key:
        raise Fatal("OPENAI_API_KEY is not set")
    url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/") + "/audio/transcriptions"

    def transcribe(audio):
        fields = [("model", a.api_model), ("response_format", "json")]
        if a.language != "auto":
            fields.append(("language", a.language))
        if a.prompt:
            fields.append(("prompt", a.prompt))
        content_type, body = multipart(fields, "speech.wav", to_wav(audio))
        request = urllib.request.Request(url, data=body, method="POST",
                                         headers={"Authorization": f"Bearer {key}", "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8")).get("text", "")
        except urllib.error.HTTPError as err:
            message = f"OpenAI transcription failed ({err.code}): {api_error(err)}"
            if err.code in (401, 403, 404):
                raise Fatal(message)
            raise RuntimeError(message)

    return transcribe


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--engine", choices=["local", "openai"], default="local")
    p.add_argument("--language", default="nl", help="a language code such as nl or en, or auto")
    p.add_argument("--control", help="the file holding listen, pause or stop")
    p.add_argument("--silence-ms", type=int, default=900, help="quiet that ends an utterance")
    p.add_argument("--device", help="input device: its index or part of its name; absent, the default")
    p.add_argument("--file", help="transcribe this 16-bit WAV instead of the microphone (a test)")
    p.add_argument("--models", help="local: the folder the Whisper models were downloaded to")
    p.add_argument("--model", default="small", help="local: the Whisper model")
    p.add_argument("--download", action="store_true", help="local: fetch the model if it is missing, then exit")
    p.add_argument("--api-model", default="gpt-4o-transcribe", help="openai: the transcription model")
    p.add_argument("--prompt", default="Claude, Claude Code", help="openai: words the speech is likely to hold")
    a = p.parse_args()

    try:
        transcribe_raw = openai_transcriber(a) if a.engine == "openai" else local_transcriber(a)
    except Exception as err:
        emit("error", message=f"could not start the {a.engine} transcriber: {err}")
        return 1
    if a.download:
        emit("ready")
        return 0

    def transcribe(audio):
        text = (transcribe_raw(audio) or "").strip()
        if not text or any(h in text.lower() for h in HALLUCINATIONS):
            return None
        return text

    seg = Segmenter(a.silence_ms)

    def feed(frame):
        was = seg.active
        utterance = seg.push(frame)
        if not was and seg.active:
            emit("speech")
        if utterance is None:
            return
        emit("heard")
        try:
            text = transcribe(utterance)
        except Fatal:
            raise
        except Exception as err:
            emit("error", message=str(err))
            emit("ignored")
            return
        if a.control and read_control(a.control) != "listen":
            return  # paused while transcribing: the answer is no longer wanted
        if text:
            emit("text", text=text)
        else:
            emit("ignored")

    if a.file:
        audio = read_wav(a.file)
        emit("ready")
        try:
            for i in range(0, len(audio) - FRAME + 1, FRAME):
                feed(audio[i:i + FRAME])
            for _ in range(seg.silence_frames + 1):
                feed(np.zeros(FRAME, dtype=np.float32))
        except Fatal as err:
            emit("error", message=str(err))
            return 1
        return 0

    import sounddevice as sd

    frames = queue.Queue()

    def callback(indata, count, at, status):
        frames.put(indata[:, 0].copy())

    device = int(a.device) if a.device and a.device.isdigit() else a.device
    try:
        stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32",
                                blocksize=FRAME, device=device, callback=callback)
        stream.start()
    except Exception as err:
        emit("error", message=f"could not open the microphone: {err}")
        return 1

    emit("ready")
    state, checked = "listen", 0.0
    try:
        while True:
            now = time.monotonic()
            if a.control and now - checked > 0.15:
                checked = now
                wanted = read_control(a.control)
                if wanted == "stop":
                    break
                if wanted != state:
                    state = wanted
                    seg.reset()
                    drain(frames)
            try:
                frame = frames.get(timeout=0.2)
            except queue.Empty:
                continue
            if state == "listen":
                feed(frame)
    except Fatal as err:
        emit("error", message=str(err))
        return 1
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop()
        stream.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
