# UX-Review Release Gate

UX-Review is release-gated as an image evidence route. In 7.4.0, the canonical `$sks-image-ux-review` picker always runs capture → senior Toss UI/UX designer gpt-image-2 I2I generation → generated-image vision/OCR extraction for a normal `run --image`; callers no longer need `--generate-callouts`. The final `image-ux-iteration-report.json` must declare `based_on_generated_image: true` and bind its severity summary and actionable UX/UI recommendations to the generated image path, hash, id, and extracted regions.

`run`, `callouts`, and `extract-issues` must reach the real gpt-image-2 adapter and real callout extractor when `SKS_TEST_REAL_IMAGEGEN=1` is enabled; otherwise the smoke gate records `integration_optional`. A passing fixture must generate annotated callout image evidence, identify that generated image as the extraction report's primary evidence, extract an issue ledger, write `image-ux-callout-extraction-report.json`, produce a patch handoff/fix task plan, and record recapture/recheck status before visual claims can move beyond fixture trust.

The image generation request and response-read timeout defaults to 180 seconds so complex I2I prompts are not cancelled inside the documented two-minute processing window. `SKS_IMAGEGEN_FETCH_TIMEOUT_MS` and the adapter's explicit timeout option still override that default.

Required release gates:

- `npm run ux-review:run-wires-imagegen`
- `node ./dist/scripts/ux-review-extract-wires-real-extractor-check.js`
- `node ./dist/scripts/ux-review-patch-diff-recheck-check.js`
- `node ./dist/scripts/ux-review-imagegen-blackbox-check.js`

Mock or generated fixture images remain `verified_partial`; they do not claim a real production UX review. The blackbox fake adapter uses the same command path and writes request, response, generated image, extraction, issue, proof, and trust artifacts, but its artifacts stay marked `mock_fixture` / `fake_imagegen_adapter`.

When gpt-image-2 annotated review images cannot be created or linked, UX-Review may close only as `verified_partial/reference-only`. That closeout requires source screenshots with hashes, docs evidence, source Image Voxel anchors, and Honest Mode evidence; it must not claim generated-image callout extraction, fix verification, or a full production UX review.
