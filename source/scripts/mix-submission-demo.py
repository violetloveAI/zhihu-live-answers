#!/usr/bin/env python3
"""Assemble timed speech, duck user-supplied music, preserve the video stream.

Intermediate audio and the supplied music are never copied into public/.
All synthesis is completed by voice-submission-demo.py first.
"""
import argparse
import array
import hashlib
import json
from pathlib import Path
import re
import subprocess
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--bgm", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((args.work / "narration-script.json").read_text())
    duration = config["duration"]
    sample_rate = 48000
    timeline = array.array("h", [0]) * round(duration * sample_rate * 2)
    timings, captions = [], []

    def run(params):
        return subprocess.run([args.ffmpeg, "-hide_banner", "-nostdin", *params], check=True, capture_output=True)

    last_end = 0
    for part in config["segments"]:
        stem = args.work / "segments" / f'{part["id"]:02d}'
        decoded = run(["-v", "error", "-i", str(stem.with_suffix(".mp3")), "-f", "s16le", "-ar", str(sample_rate), "-ac", "2", "-"]).stdout
        pcm = array.array("h")
        pcm.frombytes(decoded)
        seconds = len(pcm) / (sample_rate * 2)
        end = part["start"] + seconds
        if part["start"] < last_end or end > part["deadline"] or end > duration:
            raise ValueError(f'Segment {part["id"]} overlaps or exceeds its slot: {end:.3f}')
        offset = round(part["start"] * sample_rate) * 2
        timeline[offset:offset + len(pcm)] = pcm
        last_end = end
        timings.append({**part, "audio_seconds": seconds, "audio_end": end})
        for boundary in json.loads(stem.with_suffix(".json").read_text())["boundaries"]:
            start = part["start"] + boundary["offset"] / 1e7
            stop = min(end, start + boundary["duration"] / 1e7)
            captions.append({"start": start, "end": stop, "text": boundary["text"]})

    raw = args.work / "narration-raw.wav"
    with wave.open(str(raw), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(timeline.tobytes())

    def normalize(source, destination, target, trim=None):
        pre = f'atrim=duration={trim},asetpts=PTS-STARTPTS,' if trim else ""
        result = run(["-i", str(source), "-af", pre + f"loudnorm=I={target}:TP=-2:LRA=11:print_format=json", "-f", "null", "-"])
        measurement = json.loads(re.findall(r'\{\s*"input_i".*?\}', result.stderr.decode(), re.S)[-1])
        effect = pre + f"loudnorm=I={target}:TP=-2:LRA=11:linear=true:measured_I={measurement['input_i']}:measured_TP={measurement['input_tp']}:measured_LRA={measurement['input_lra']}:measured_thresh={measurement['input_thresh']}:offset={measurement['target_offset']}"
        run(["-v", "error", "-i", str(source), "-af", effect, "-ar", str(sample_rate), "-ac", "2", "-c:a", "pcm_s24le", "-y", str(destination)])
        return measurement

    voice = args.work / "narration.wav"
    music = args.work / "music-normalized.wav"
    measures = {"voice": normalize(raw, voice, -18), "music": normalize(args.bgm, music, -29, duration)}
    mixed = args.work / "mix-pre-master.wav"
    filters = (
        "[0:a]asplit=2[voice][key];"
        f"[1:a]afade=t=in:st=0:d=1,afade=t=out:st={duration-3}:d=3[music];"
        "[music][key]sidechaincompress=threshold=0.045:ratio=2:attack=25:release=420[ducked];"
        "[voice][ducked]amix=inputs=2:duration=first:normalize=0[out]"
    )
    run(["-v", "error", "-i", str(voice), "-i", str(music), "-filter_complex", filters, "-map", "[out]", "-t", str(duration), "-ar", str(sample_rate), "-ac", "2", "-c:a", "pcm_s24le", "-y", str(mixed)])
    master = args.work / "mix.wav"
    measures["mix"] = normalize(mixed, master, -17)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run(["-v", "error", "-i", str(args.work / "original-silent.mp4"), "-i", str(master), "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", str(sample_rate), "-ac", "2", "-movflags", "+faststart", "-y", str(args.output)])
    # Preserve real sentence timestamps; never claim word-level alignment.
    for left, right in zip(captions, captions[1:]):
        left["end"] = min(left["end"], right["start"])

    def clock(seconds, comma=False):
        ms = round(seconds * 1000)
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f'{h:02}:{m:02}:{s:02}{"," if comma else "."}{ms:03}'

    for extension in ("srt", "vtt"):
        blocks = ["WEBVTT\n"] if extension == "vtt" else []
        for i, cue in enumerate(captions, 1):
            timing = f'{clock(cue["start"], extension == "srt")} --> {clock(cue["end"], extension == "srt")}'
            if extension == "vtt":
                timing += " line:6% position:50% size:85% align:middle"
            blocks.append(f'{i}\n{timing}\n{cue["text"]}\n')
        (args.work / f"demo.{extension}").write_text("\n".join(blocks), encoding="utf-8")
    (args.work / "audio-timing.json").write_text(json.dumps({
        "duration": duration, "timing_source": "Edge TTS sentence boundaries; narration fits the existing video timeline without speed changes",
        "voice": {k: config[k] for k in ("voice", "rate", "pitch", "volume")},
        "bgm": {"title": "You and Me", "creator": "しゃろう", "library_id": "D", "source": "https://dova-s.jp/bgm/detail/13787", "sha256": hashlib.sha256(args.bgm.read_bytes()).hexdigest(), "excerpt_start": 0, "looped": False},
        "mix": {"narration_target_lufs": -18, "music_target_lufs_before_ducking": -29, "final_target_lufs": -17, "true_peak_limit": -2, "fade_in": 1, "fade_out": 3},
        "segments": timings, "captions": captions, "measurements": measures,
    }, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"segments": len(timings), "captions": len(captions), "speech_ends": last_end, "video_duration": duration, "output_bytes": args.output.stat().st_size, "picture_stream": "unchanged / copied"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
