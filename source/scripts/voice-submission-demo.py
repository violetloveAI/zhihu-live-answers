#!/usr/bin/env python3
"""Synthesize the approved synthetic voice in timed segments; no account secrets.

Requires edge-tts. Inputs and intermediate audio stay outside public/.
Usage: python voice-submission-demo.py script.json --output WORK_DIRECTORY
"""
import argparse
import asyncio
import json
from pathlib import Path

import edge_tts


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("script", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.script.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    for segment in config["segments"]:
        stem = args.output / f'{segment["id"]:02d}'
        metadata = stem.with_suffix(".json")
        signature = {**segment, **{k: config[k] for k in ("voice", "rate", "pitch", "volume")}}
        if metadata.exists() and stem.with_suffix(".mp3").exists():
            saved = json.loads(metadata.read_text())
            if saved.get("request") == signature:
                print(f'Cached segment {segment["id"]}', flush=True)
                continue
        for attempt in range(3):
            try:
                communicate = edge_tts.Communicate(
                    segment["text"], voice=config["voice"], rate=config["rate"],
                    pitch=config["pitch"], volume=config["volume"], boundary="SentenceBoundary",
                )
                boundaries = []
                with stem.with_suffix(".tmp").open("wb") as audio:
                    async for item in communicate.stream():
                        if item["type"] == "audio":
                            audio.write(item["data"])
                        elif item["type"] in ("SentenceBoundary", "WordBoundary"):
                            boundaries.append(item)
                stem.with_suffix(".tmp").replace(stem.with_suffix(".mp3"))
                metadata.write_text(json.dumps({"request": signature, "boundaries": boundaries}, ensure_ascii=False, indent=2) + "\n")
                print(f'Generated segment {segment["id"]}', flush=True)
                break
            except Exception:
                stem.with_suffix(".tmp").unlink(missing_ok=True)
                if attempt == 2:
                    raise
                await asyncio.sleep(1 + attempt)


if __name__ == "__main__":
    asyncio.run(main())
