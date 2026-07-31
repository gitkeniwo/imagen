"""One-off probe: confirm the live Vertex AI image API works via ADC.

Uses Vertex AI with ADC (vertexai=True + project + location) via the
google-genai SDK, matching the app. Requires `gcloud auth application-default
login` (+ set-quota-project) done on this machine first.

Usage (from the backend/ directory):
    PROJECT=my-proj uv run python scripts/probe_gemini.py [image.png]

With no image arg it does text->image; with an image it does image->image editing.
Test Pro + resolution:
    PROJECT=my-proj MODEL=gemini-3-pro-image RESOLUTION=2K \
        uv run python scripts/probe_gemini.py
"""
import os
import sys

from google import genai
from google.genai import types

MODEL = os.environ.get("MODEL", "gemini-2.5-flash-image")
RESOLUTION = os.environ.get("RESOLUTION")  # "1K" | "2K" | "4K" (Pro only)
PROJECT = os.environ.get("PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = os.environ.get("LOCATION") or os.environ.get("GOOGLE_CLOUD_LOCATION") or "global"
PRO = MODEL == "gemini-3-pro-image"


def main() -> None:
    if not PROJECT:
        sys.exit("Set PROJECT (or GOOGLE_CLOUD_PROJECT)")

    parts = [types.Part.from_text(text="A cute banana mascot, studio lighting")]
    if len(sys.argv) > 1:
        data = open(sys.argv[1], "rb").read()
        parts.append(types.Part.from_bytes(data=data, mime_type="image/png"))

    image_config = types.ImageConfig(
        aspect_ratio="1:1",
        image_size=RESOLUTION if (RESOLUTION and PRO) else None,
    )
    config = types.GenerateContentConfig(
        response_modalities=["TEXT", "IMAGE"],
        image_config=image_config,
        # Relax all configurable safety categories to OFF, same as the app.
        safety_settings=[
            types.SafetySetting(category=c, threshold="OFF")
            for c in (
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_HARASSMENT",
                "HARM_CATEGORY_CIVIC_INTEGRITY",
                "HARM_CATEGORY_IMAGE_HATE",
                "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT",
                "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_IMAGE_HARASSMENT",
            )
        ],
    )

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=config,
    )

    cand = resp.candidates[0] if resp.candidates else None
    print("finish_reason:", getattr(cand, "finish_reason", None))
    print("prompt_feedback:", getattr(resp, "prompt_feedback", None))
    for i, p in enumerate((cand.content.parts if cand and cand.content else []) or []):
        inline = getattr(p, "inline_data", None)
        if inline and inline.data:
            out = f"probe_out_{i}.png"
            open(out, "wb").write(inline.data)
            print(f"part {i}: image {inline.mime_type}, {len(inline.data)} bytes -> {out}")
        elif getattr(p, "text", None):
            print(f"part {i}: text: {p.text[:200]}")


if __name__ == "__main__":
    main()
