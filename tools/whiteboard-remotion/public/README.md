# Whiteboard Hand Asset

Place a PNG file named `whiteboard-hand.png` here.

Requirements:
- Transparent background (PNG with alpha)
- The pen tip should be near the **top-left** of the image (approximately 0% from left, 20% from top)
- Recommended size: 200×200 px or larger
- The engine scales the displayed hand to 480×480 px in the video

A default placeholder (simple marker icon) is generated at runtime if this file does not exist.
The hand PNG offset constants in `WhiteboardComposition.tsx` can be tuned:
- `HAND_TIP_OFFSET_X` — pen-tip X as fraction of hand width (default 0)
- `HAND_TIP_OFFSET_Y` — pen-tip Y as fraction of hand height (default 0.2)
