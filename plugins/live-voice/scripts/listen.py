"""The ears of the live-voice Claude Code mod.

Listens to the microphone, cuts speech into utterances by loudness, transcribes
each one with faster-whisper on the CPU, and prints one JSON object per line:

  {"type": "ready"}               the model is loaded and the microphone open
  {"type": "speech"}              someone started talking
  {"type": "heard"}               an utterance ended and is being transcribed
  {"type": "text", "text": "..."} what was said
  {"type": "ignored"}             the utterance held no words
  {"type": "error", "message": "..."}

The control file holds one word: listen, pause or stop. While paused, audio is
thrown away, so the mod can talk without hearing itself; stop ends the process.
"""
import argparse
import json
import queue
import sys
import time

import numpy as np

RATE = 16000
FRAME = 480  # 30 ms at 16 kHz

# What Whisper writes for silence or noise, learned from subtitled video.
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
    import wave

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


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--models", required=True, help="the folder the Whisper models were downloaded to")
    p.add_argument("--model", default="small")
    p.add_argument("--language", default="nl", help="a language code such as nl or en, or auto")
    p.add_argument("--control", help="the file holding listen, pause or stop")
    p.add_argument("--silence-ms", type=int, default=900, help="quiet that ends an utterance")
    p.add_argument("--device", help="input device: its index or part of its name; absent, the default")
    p.add_argument("--file", help="transcribe this 16-bit WAV instead of the microphone (a test)")
    p.add_argument("--download", action="store_true", help="fetch the model if it is missing, then exit")
    a = p.parse_args()

    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(a.model, device="cpu", compute_type="int8",
                             download_root=a.models, local_files_only=not a.download)
    except Exception as err:
        emit("error", message=f"could not load the Whisper model {a.model}: {err}")
        return 1
    if a.download:
        emit("ready")
        return 0

    language = None if a.language == "auto" else a.language
    seg = Segmenter(a.silence_ms)

    def transcribe(audio):
        segments, _ = model.transcribe(audio, language=language, beam_size=5,
                                       vad_filter=True, condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
        if not text or any(h in text.lower() for h in HALLUCINATIONS):
            return None
        return text

    def feed(frame):
        was = seg.active
        utterance = seg.push(frame)
        if not was and seg.active:
            emit("speech")
        if utterance is None:
            return
        emit("heard")
        text = transcribe(utterance)
        if a.control and read_control(a.control) != "listen":
            return  # paused while transcribing: the answer is no longer wanted
        if text:
            emit("text", text=text)
        else:
            emit("ignored")

    if a.file:
        audio = read_wav(a.file)
        emit("ready")
        for i in range(0, len(audio) - FRAME + 1, FRAME):
            feed(audio[i:i + FRAME])
        for _ in range(seg.silence_frames + 1):
            feed(np.zeros(FRAME, dtype=np.float32))
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
    except KeyboardInterrupt:
        pass
    finally:
        stream.stop()
        stream.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
