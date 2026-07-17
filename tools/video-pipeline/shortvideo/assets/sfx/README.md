# ShortVideo transition SFX

Drop a short sound effect here to be played whenever the `dragonPose` changes
between consecutive scenes (e.g. `left → right`, `left → question`).

Priority of resolution (first match wins):

1. `spec.transitionSound` (or `spec.sfx`) — a filename resolved from the job
   `assetsDir` (this is what the standalone menu upload sets).
2. A bundled default in this folder named `transition.<ext>` where `<ext>` is one
   of: `.mp3`, `.wav`, `.m4a`, `.ogg`.

If no file is found, the transition is silent (feature is a no-op).

Keep the clip short (~0.2–0.6s) — a whoosh / pop works best. Volume can be tuned
via `engineConfig.transitionSfxVolume` (0..2, default 0.8).
