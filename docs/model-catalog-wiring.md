# Model catalog and picker wiring

How a provider model becomes a row in the Codex Desktop picker, and where the
8.3.2/8.3.3 defects sat. Read this before changing catalog normalization, the
Swift truth decoders, or Doctor's repair phases.

## Catalog build path

```mermaid
flowchart TD
  GW["codex-lb gateway<br/>GET {base}/models"] -->|"models[] native ModelInfo (50 fields)<br/>data[] OpenAI-compatible (18 fields)"| READ
  OR["OpenRouter<br/>GET /api/v1/models"] -->|"~400 rows"| NORM_OR

  READ["readCodexLbModelCatalog<br/>codex-lb-env.ts"] -->|"model_rows (full ModelInfo)<br/>+ models (slug list)"| NORM_LB
  NORM_LB["normalizeCodexLbBridgeCatalogModels<br/>+ canonicalModel"] --> MERGE
  NORM_OR["normalizeProviderCatalog (openrouter)<br/>+ codexModelInfoFields defaults"] --> MERGE

  MERGE["buildCombinedBridgeCatalog<br/>compareModels: codex-lb before openrouter"] --> SEL
  SEL{"applyBridgeModelSelection"} -->|"codex-lb: always"| ACTIVE
  SEL -->|"openrouter: selected public_ids only"| ACTIVE
  MERGE -->|"every openrouter row"| AVAIL["sks-bridge-available-models.json<br/>(selection source for SKS Center)"]

  ACTIVE["active generation<br/>.sks-bridge-generations/&lt;gen&gt;/sks-bridge-catalog.json"] --> CFG
  ACTIVE --> ROUTE["route index + route policy<br/>(routing follows the same filtered set)"]
  CFG["~/.codex/config.toml<br/>model_catalog_json = &lt;gen path&gt;"] --> PICKER["Codex Desktop picker<br/>reasoning selector · Fast tier · model list"]

  SELFILE["sks-bridge-model-selection.json<br/>schema sks.bridge-model-selection.v1"] --> SEL
  CENTER["SKS Center · Codex Picker Exposure"] -->|"bridge models select --set"| SELFILE
  CENTER -->|"bridge models list"| AVAIL
```

Two properties this path must keep:

- **Routing and exposure share one source.** The active catalog feeds both the
  picker and the route index, so a model that is not exposed is also not
  routable. There is no hidden second list.
- **Provider rows are preserved, never rebuilt.** The gateway already serves a
  complete Codex ModelInfo row. SKS layers routing identity (`provider_id`,
  `route_key`, `public_id`) on top and passes everything else through.

## SKS Center read path

```mermaid
flowchart LR
  UI["SKS Center card"] --> PC["ProcessClient<br/>1MB output cap"]
  PC --> CLI["sks &lt;command&gt; --json"]
  CLI --> TRUTH{"strict Swift decoder"}
  TRUTH -->|"status envelope<br/>ok/execution_ok/command_summary optional"| RENDER["render rows"]
  TRUTH -->|"command receipt<br/>execution.status + nested service"| RENDER
  TRUTH -->|"native process error<br/>timeout / output_limit"| ERR["surface the real code"]
```

The decoders are exact-key contracts. Any new top-level CLI field must be added
to the allowed key set in the same change, or every affected card fails closed
and renders "schema invalid".

## Defects this wiring encodes

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Picker had no reasoning levels; Fast mode missing for Codex-LB | Gateway response carries `models` **and** `data`; the parser read `data` (18 fields), then the normalizer and `canonicalModel` rebuilt only the required subset | Prefer `models`; preserve upstream rows in both normalizer and `canonicalModel` |
| Picker buried Codex-LB behind ~389 OpenRouter rows | Unfiltered catalog plus alphabetical merge | `compareModels` orders codex-lb first, ModelInfo `priority` 100, and OpenRouter exposure became opt-in |
| Combined Catalog "Refresh" reported schema invalid | Envelope trio was made *required* on the status decoder, but the status nested in a command result never carries it | Allowed-and-type-checked, never required |
| Provider rows stuck on "checking…" | Same decoder, live `bridge status` path | Same fix |
| Center actions timed out on routing-aware commands | 64KB `ProcessClient` cap vs ~120KB catalog-aware JSON | 1MB cap |
| `doctor --fix` printed `retry_catalog_sync` but never repaired | No repair phase existed for a stale catalog | `desktop_bridge_catalog_repair` phase |
| `doctor --fix` deleted `openai_base_url` and `notify` | Doctor rooted at `$HOME` made the project-local stripper resolve onto the global config | Project pass skips the codex home config |
| Run Doctor button appeared inert | `doctor --json` selects the fast read-only profile and skips every deep diagnostic | Runs `doctor --full --json` |
