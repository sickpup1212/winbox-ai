#!/usr/bin/env python3
"""
create_card.py — build a v2 character-card PNG from a JSON.

Usage:
    python3 create_card.py card.json [-o aria.png] [--avatar avatar.png]

Reads a card JSON file (the v2 chara_card_v2 shape) and writes a PNG with the
card data embedded in a `chara` tEXt chunk — compatible with this app and
standard v2 card tooling (SillyTavern etc.).

The card JSON file should look like:
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "Aria",
    "description": "...",
    "personality": "...",
    "scenario": "...",
    "first_mes": "...",
    "mes_example": "...",
    "system_prompt": "",
    "post_history_instructions": "",
    "alternate_greetings": [],
    "character_book": { "name": "Lore", "entries": [...] },
    "tags": ["fantasy", "ranger"],
    "creator": "you",
    "character_version": "1.0",
    "extensions": {}
  }
}
"""
import argparse
import base64
import json
import struct
import sys
import zlib


def _crc32(data: bytes) -> int:
    """Standard PNG CRC-32."""
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
    return crc ^ 0xFFFFFFFF


def _chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", _crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def build_character_card(card_json: dict, avatar_png: bytes | None = None) -> bytes:
    """Return a v2 character-card PNG (bytes) from a card dict.

    If avatar_png is provided it is used as the image; otherwise a 1x1
    transparent placeholder is emitted. Either way the `chara` tEXt chunk
    is embedded so the card data survives.
    """
    # Encode the card JSON as the chara tEXt chunk value.
    b64 = base64.b64encode(json.dumps(card_json).encode("utf-8"))
    text_chunk = _chunk(b"tEXt", b"chara\x00" + b64)

    if avatar_png and avatar_png[1:4] == b"PNG":
        img = avatar_png
    else:
        # 1x1 transparent RGBA PNG.
        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
        idat = zlib.compress(b"\x00\x00\x00\x00\x00")
        img = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", idat)
            + _chunk(b"IEND", b"")
        )

    # Insert the chara chunk right after IHDR (8 sig + IHDR chunk = 8+25).
    ihdr_end = 8 + 25
    return img[:ihdr_end] + text_chunk + img[ihdr_end:]


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a v2 character-card PNG.")
    parser.add_argument("json_file", help="Path to the card JSON file")
    parser.add_argument("-o", "--output", default="character.png", help="Output PNG path")
    parser.add_argument("--avatar", default=None, help="Optional avatar PNG path to embed")
    args = parser.parse_args()

    try:
        with open(args.json_file, "r", encoding="utf-8") as f:
            card = json.load(f)
    except Exception as e:
        print(f"Error reading {args.json_file}: {e}", file=sys.stderr)
        return 1

    avatar = None
    if args.avatar:
        try:
            with open(args.avatar, "rb") as f:
                avatar = f.read()
        except Exception as e:
            print(f"Error reading avatar {args.avatar}: {e}", file=sys.stderr)
            return 1

    try:
        png = build_character_card(card, avatar)
        with open(args.output, "wb") as f:
            f.write(png)
    except Exception as e:
        print(f"Error building card: {e}", file=sys.stderr)
        return 1

    print(f"Wrote {args.output} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
