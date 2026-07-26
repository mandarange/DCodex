# UX-Review Real Loop

SKS 7.4.0 exposes one picker skill, `$sks-image-ux-review`. The old `$sks-ux-review`, `$sks-visual-review`, and `$sks-ui-ux-review` names remain internal compatibility aliases that resolve to the same route.

Every normal `run --image` executes the same three-stage review chain:

1. Capture the actual page through Codex Chrome for web/browser/webapp targets, use Codex Computer Use for native Mac/non-web targets, or accept a user-provided local screenshot.
2. Send that screenshot to gpt-image-2 with a senior Toss UI/UX designer I2I brief. The generated image must annotate P0–P3 issues, hierarchy, contrast, density, affordance, eye flow, and a mini-comp; prose alone is invalid.
3. Read the generated image back through vision/OCR, write schema-bound issues to `image-ux-issue-ledger.json`, and produce `image-ux-iteration-report.json` with recommendations tied to generated-image regions and hashes.

A valid run also needs:

- P0/P1-first fix task planning and a bounded safe fix loop when fixes are requested.
- Recapture/re-review evidence before any changed-screen visual fix is verified.
- Image Voxel source/generated/fixed relations plus Completion Proof, Trust Report, and Wrongness evidence.

Commands:

```bash
sks ux-review run --image screen.png --fix --json
sks ux-review callouts --image screen.png --json
sks ux-review extract-issues --generated-image review.png --json
sks ux-review fix latest --json
sks ux-review recapture latest --json
sks ux-review recheck latest --json
sks ux-review status latest --json
```

Mock fixtures remain `verified_partial`. Text-only screenshot critique, placeholder generated images, fabricated ledgers, and mock-as-real evidence are blocked by `image-ux-review-gate.json`.

If gpt-image-2 annotated images cannot be created or linked, the route may stop as `verified_partial/reference-only` instead of looping forever. That status is allowed only when source screenshots plus hashes, docs evidence, source Image Voxel anchors, and Honest Mode evidence exist, and the gate plainly records that generated-image callout extraction and full UX verification are unavailable.
