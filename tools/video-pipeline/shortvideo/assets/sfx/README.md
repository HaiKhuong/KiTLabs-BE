# ShortVideo transition SFX library

Each scene can declare a named transition sound played at the scene's start:

```json
{ "dragonPose": "left", "focus": "left", "transitionSound": "whoosh_fast", "duration": 2 }
```

The name `whoosh_fast` resolves to a file in this folder:

- `assets/sfx/whoosh_fast.mp3` (or `.wav`, `.m4a`, `.ogg`)

Resolution order for a scene's `transitionSound`:

1. A file with that name provided in the job `assetsDir`.
2. A bundled file here: `assets/sfx/<name>.<ext>`.

Drop your sound library files here, e.g. `whoosh_fast.mp3`, `pop.mp3`, `swoosh.mp3`.

Legacy fallback (only when NO scene declares a `transitionSound`):
- top-level `spec.transitionSound` / `spec.sfx`, else a bundled `transition.<ext>`,
  played at each dragon-pose change.

Keep clips short (~0.2–0.6s). Volume via `engineConfig.transitionSfxVolume` (0..2, default 0.8).
