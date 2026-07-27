# Dragon mascot poses by style

Each style folder holds transparent PNG mascot poses named `<pose>.png`,
matching `dragonPose` values in scene specs:

- `left.png`
- `right.png`
- `question.png`
- `compare.png`
- `happy.png`
- `bye.png`

## Folder layout

```
assets/dragon/
  default/              # fallback when style folder is missing
  nha-sinh-vat-hoc/
  nha-dia-ly/
  nha-tham-hiem/
  nha-thien-van-hoc/
  nha-co-sinh-vat-hoc/
  nha-khao-co/
  kien-truc-su/
  ky-su/
  nha-hoa-hoc/
```

Set `spec.style` (or `engineConfig.style`) to one of the slugs above.
If a pose file is missing in the style folder, the renderer skips that pose.

Recommended: square-ish transparent PNGs (~1000x1000).
