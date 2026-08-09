# 인수인계서 — SKS 8.3.3 릴리스 및 8.4.0 Architecture Atlas

작성 시점 기준 상태. **검증됨 / 미검증**을 항목마다 표시했다. 미검증 항목을 완료로 취급하지 말 것.

---

## 0. 한 눈에

| 항목 | 상태 |
|---|---|
| 8.3.3 릴리스 | **완료** — `origin/main` = `5fb6fb70`, 태그 `v8.3.3` 푸시됨. `npm publish`만 남음 (사용자 직접 수행) |
| 8.4.0 base freeze | **완료** — `5fb6fb7024507a71207b4926b3ec7210c2aa65f2` (8.3.3) |
| 브랜치 | `integration/architecture-atlas-8.4.0`, HEAD `e3d369f0` |
| Baseline ledger | **완료** — `baseline.json`, 커밋 `e3d369f0` |
| 재감사 (11 에이전트) | **완료** — 작업지시서 전제 다수 반증 |
| 설계 확정 (6 프로브) | **완료** — 결정 6건 + 지시서 수정안 9건 |
| Wave 1 소스 | **작성됨, 빌드·테스트 미검증** |
| Wave 1 등록 (A00) | **미착수** |
| Wave 2 / Wave 3 | **미착수** |

---

## 1. 8.3.3 (완료)

`origin/main` = `5fb6fb70`, 태그 `v8.3.3` 원격 반영됨. 레지스트리는 아직 `8.3.2`.

남은 작업은 하나뿐:

```bash
npm publish --registry https://registry.npmjs.org/ --tag latest --access public
```

**검증됨** — 아래 receipt 전부 통과:

| 게이트 | 결과 |
|---|---|
| `release:check:full` | exit 0, 스탬프 3049 파일 |
| `release-check-stamp verify` | verified |
| `release-pack-receipt verify` | exit 0 |
| `release-provenance --publish` | ok, blockers 0 |
| 캐노니컬 스위트 | 2824 pass / 0 fail |
| Atlas 외 신규 focused 테스트 | 10 pass |

### 8.3.3에 들어간 것

- combined catalog가 게이트웨이의 완전한 Codex ModelInfo 행을 보존 (50필드). 게이트웨이는 `/models`에 native `models`(50필드)와 OpenAI 호환 `data`(18필드)를 **둘 다** 주는데 SKS가 `data`를 먼저 읽고 필수 subset만 재구성해서 Desktop의 추론 셀렉터가 비고 Fast 티어가 사라졌던 문제.
- 추론 가능한 OpenRouter 모델에 `low/medium/high/xhigh` 사다리 + default `medium`. **실제 왕복으로 검증함** — 브리지 경유 5개 rung 전부 200, `response.created`가 effort를 그대로 echo, `reasoning_text.delta`가 effort에 따라 단조 증가 (none 0 / minimal 21 / low 22 / medium 42 / xhigh 50).
- OpenRouter 피커 노출 opt-in 큐레이션 (`sks bridge models list|select --set` + SKS Center 카드).
- `doctor --fix`의 `desktop_bridge_catalog_repair` 단계; 전역 Codex config에서 host 소유 행을 지우던 버그 수정; SKS Center Run Doctor가 `doctor --full --json` 실행.

---

## 2. 8.4.0 — 지금까지 확정된 것

### 2.1 사용자 결정 (확정, 재논의 불가)

1. **새 release gate ID를 만든다** — `architecture:guard`에 submode를 붙이지 않는다.
2. **Mermaid 에미터는 기존 gx-renderer의 normalized view-model 위에서 구동한다** — 별도 포맷을 새로 만들지 않는다.

### 2.2 작업지시서가 틀린 곳 (재감사·설계 프로브로 실측)

인수인계 받는 쪽은 **원문 작업지시서를 그대로 믿지 말 것**. 아래는 코드로 반증된 항목.

| # | 지시서 주장 | 실제 |
|---|---|---|
| 0 | Context Graph에 14개 node kind가 있다 | **실제 그래프에는 4개뿐** — `file 2877, module 118, symbol 21727, test 915`, edge 7종. `command`/`route`/`pipeline`/`gate`/`wiki_claim`/`source`/`proof`/`risk_domain`/`schema`/`config`는 **0개**. align이 `codeNavigationGraphExtractors()`로 컴파일하고 `code-navigation-align.ts:323`에서 단일 extractor를 hard-assert하기 때문. |
| 1 | non-negotiable 7: `architecture:guard`에 submode 추가 | `architecture-guard-check.ts`는 82줄 `@ts-nocheck`이고 `check-architecture`를 실행하지 않음. `process.argv` 참조 0개라 submode 불가. `safe_subgate` 필드는 죽은 타입. |
| 2 | Atlas를 `.sneakoscope/wiki/architecture-atlas/`에 | 그 디렉터리는 align마다 통째 교체됨. 게다가 `architecture-atlas`라는 이름은 **이미 gx-command.ts:135가 쓰고 있음**. → `.sneakoscope/wiki/atlas/`로 변경. |
| 3 | non-negotiable 6: Align publisher 재사용 | 추출 가능한 publisher가 없음. 전체가 export 안 된 `runLocked`(`code-navigation-align.ts:249-458`) 안에 ledger 변경 ~40개와 뒤섞임. |
| 4 | source CAS가 발행 후 실행되고 그 창이 Atlas를 커버 | Atlas는 **발행 전** staging에 써야 함. 발행 후 CAS는 `wikiContextHash: empty`로 고정(`cache-key.ts:361`)이고 `.sneakoscope`는 `EXCLUDED_ROOT_DIRS`(`inventory.ts:24-34`)라 Atlas 바이트가 그 키를 절대 못 움직임. |
| 5 | (지시서에 없음 — 반드시 추가) | `code-navigation-align.ts:234`가 `path.basename()`을 씀. Atlas 경로를 등록하면 **모든** align이 `code_navigation_staging_validation_failed`로 깨지는데 메시지에 Atlas가 안 나옴. |
| 6 | 루트에 `sks.architecture.json` | `sks.*.json` 루트 파일명 전례 없음. `sks.`는 schema 문자열 namespace지 파일명 namespace가 아님. → `config/architecture-atlas.v1.json`. |
| 7 | gx view-model 재사용은 공짜 | `normalizeVGraph(vgraph: any = {})`가 반환 타입을 선언하지 않아 `.nodes`/`.edges`가 `any`로 추론됨. public contract에 `any` 금지이므로 타입 좁히기 계층 ~140줄이 **신규**. `slug()`는 injective가 아니라 Mermaid id로 재사용 불가. |
| 8 | 4개 게이트가 전부 publish에서 실행 | `release-gate-dag.ts:426-435`가 preset `release`를 `['release']`로만 확장. confidence preset 게이트는 `release:check:full`에서 **실행되지 않음**. 기존 `context-graph:*` 4개도 전부 confidence-only라 publish에서 아무것도 게이팅하지 않음. |
| 9 | 지시서 §2.1 관찰값 (2734/20734/64334) | 그건 2026-08-07(8.3.2 시절) 스냅샷. base_sha 실제값은 **2877 / 21727 / 67204**. |

### 2.3 설계 결정 (확정)

| 질문 | 결정 |
|---|---|
| Mermaid ↔ gx 레이어링 | `normalizeVGraph`, `vgraphHash`, `validateVGraph`만 import. `slug()`/`escapeXml()`은 **쓰지 않음**. node id = `n_` + RFC4648 소문자 base32(sha256(sourceId))[0:12], 충돌 시 throw. gx엔 조건부 spread 1개만 추가. |
| Atlas 출력 위치 | `.sneakoscope/wiki/atlas/`, `stageWiki/atlas/`로 staging 후 기존 rename 하나로 승격. 12개 파일 전부 `ALIGN_OUTPUT_ARTIFACTS`에 열거. |
| 게이트 ID | 4개, `atlas:` prefix, 단일 스크립트 `src/scripts/atlas-check.ts --mode <m>`. `atlas:contract`·`atlas:legacy-closure`는 preset `release`, `atlas:mermaid-compatibility`·`atlas:regression`은 `confidence`. |
| 소스 위치 | `src/core/triwiki/atlas/**` — module card `triwiki`(`triwiki-module-card.ts:15`)가 카드 수정 없이 매칭. `context-graph/**` 안에 넣으면 `context-graph:*` 게이트 캐시가 churn됨. |
| 파이프라인 버킷 | `architecture_preflight`→`ownership`, `architecture_postflight`→`verification`. `gateProfile`이 `scoped`/`full`일 때만 push. |
| 정책 파일 | `config/architecture-atlas.v1.json`. `layers`/`boundaries`/`thresholds`/`exceptions`만 선언. `ssot_domains`·`required_paths`·`protected_modules`-for-gates는 **기존 권위에 위임**. |
| 그래프 접근 | `openAtlasGraph(root)` 하나. `contextGraphStatus` → fresh 아니면 fail closed → `loadContextGraphIndex(root,{status,cache:true})`. `compileContextGraph` 절대 호출 안 함, SCC 재계산 안 함. |

### 2.4 내가 확정한 Wave 1 결정 4건 (근거: 작업지시서 본문)

| 항목 | 결정 | 근거 |
|---|---|---|
| `htmlLabels` | **false** | §9.1이 raw HTML label 금지 |
| `.mmd` 추적 | **gitignore** | §6.2 "generated cache artifacts and must be ignored by Git" |
| Base32 | **RFC4648 소문자** | §9.2의 `[a-z][a-z0-9_]*` 제약 |
| 정책 파일 배포 | cwd 전용, `package.json` `files`에 **미포함** | `architecture-budgets.v1.json`이 배포되지만 cwd에서만 읽혀 dead weight인 전례 반복 회피 |

---

## 3. Wave 1 — 현재 상태

**소스 9개 파일 작성 완료. 빌드·테스트 미검증** (통합 단계 진행 중이었음).

| 파일 | 줄 | 슬롯 |
|---|---:|---|
| `src/core/triwiki/atlas/atlas-views.ts` | 55 | A01 |
| `src/core/triwiki/atlas/mermaid-syntax.ts` | 178 | A01 |
| `src/core/triwiki/atlas/view-model.ts` | 275 | A02 |
| `src/core/triwiki/atlas/emit.ts` | 373 | A03 |
| `src/core/triwiki/atlas/__tests__/emit.test.ts` | 228 | A03 |
| `src/core/triwiki/atlas/__tests__/mermaid-parse.test.ts` | 270 | A03 |
| `src/core/triwiki/atlas/graph-access.ts` | 122 | A04 |
| `config/architecture-atlas.v1.json` | 193 | A05 |
| `src/core/triwiki/atlas/atlas-policy.ts` | 347 | A05 |

전부 450줄 미만 — 예산 통과. `src/scripts/atlas-check.ts` (A06)는 **아직 디스크에 없음**.

`src/core/gx-renderer.ts`는 **검증됨** — 조건부 spread 정확히 1개 + 이유 주석 4줄. `atlas` 키 없는 vgraph의 `vgraphHash`는 불변.

### 3.1 Wave 1에 남은 일

**(a) 통합** — 빌드 1회, 타입 에러 수정, Atlas 유닛 테스트 실행. `mermaid` devDependency가 아직 없으므로 `mermaid-parse.test.ts`는 **그 이유로만** 실패해야 정상.

**(b) A00 등록** — Release Director 전용. release preset ID 하나당 **8곳**:

1. `release-gates.v2.json` 노드 (key 순서는 `:4535-4571` 그대로)
2. `src/core/release/gate-manifest.ts` 에 **새 `case 'atlas':`** — 없으면 `default:`(`:170-172`)로 떨어져 스크립트 자기 자신이 움직일 때만 발화함
3. `package.json` `files` brace group (`:44`) — `runtime-script-pack-closure-check.ts:68-71`이 정확 집합 일치를 단언
4. `src/core/release/release-gate-contract.ts` `RELEASE_GATE_CONTRACT_IDS` (`:5-37`)
5. `src/scripts/release-metadata-check.ts` `requiredReleaseGates` (`:66-98`)
6. `release-gate-contract.test.ts:52` 의 `assert.equal(releaseIds.length, 31)` → `32`
7. 재빌드 + `release-check-stamp.ts:96-98` 재작성
8. docs 표

**confidence preset ID는 4·5번에 넣으면 안 됨** — `release-dag-full-coverage-check.ts:37-39`와 `release-gate-contract.test.ts:28`의 `deepEqual`이 깨짐.

`package.json` 스크립트는 등록 지점이 **아님** (`context-graph:*`도 없음). 예산이 99/101이라 여유 없음.

**(c) `mermaid` devDependency** — exact pin으로 추가. 현재 `devDependencies`엔 `@types/node`뿐.

**(d) Wave 1 exit receipt 14개** — 전체 목록은 설계 문서 참조. 핵심만:
- 매니페스트 게이트 수 152 → **154**
- `atlas-check.js --mode bogus` → **exit 1** + `atlas_check_unknown_mode` (fail-closed 증거)
- 해시 불변: `vgraphHash(defaultVGraph('x'))`가 gx 편집 전후 **바이트 동일**
- 결정성: 같은 프로세스 2회 + 새 프로세스에서 `TZ=UTC` / `TZ=Asia/Seoul` → 4개 출력 sha256 동일
- `npm run architecture:check` — **별도 필수**. 450줄 규칙은 release DAG에 없고 publish 워크플로에만 있음
- `release:check:full` → `release-check-stamp verify` (contract sha256을 재생성하는 유일한 경로)

`release-gates.v2.json`을 건드리면 거의 모든 게이트 캐시가 무효화되므로(`release-gate-cache-v2.ts:55`) 마지막 `release:check:full`은 사실상 full run이 된다. 회귀로 읽지 말 것.

---

## 4. Wave 2 / Wave 3 (미착수)

**Wave 2 — Align 발행.** `.sneakoscope/wiki/atlas/`, `ALIGN_OUTPUT_ARTIFACTS` 확장, `code-navigation-align.ts:357-362` 뒤 에미터 호출, **`:234` prefix 수정(필수)**, `.gitignore` 수동 tail 규칙(`:195` 아래 — `GITIGNORE_BLOCK` 관리 구간은 절대 건드리지 말 것, 다음 `installGitignoreBlock`이 지움), `managed-paths.ts:28-34` 행, align 테스트의 tamper 단언. 추가로 `atlas:legacy-closure`(release, contract id 32→33)와 `atlas:regression`(confidence).

**Wave 3 — 파이프라인 스테이지 + Stop 게이트.** 가장 blast radius가 큼. **7개 task profile 중 5개가 이미 blocking-gate 한도에 딱 붙어 있음** (tiny-change 1/1, bounded-work 2/2, parallel-read 2/2, high-risk 4/4; parallel-write만 2/3 여유). 새 버킷을 만들면 `BLOCKING_GATE_LIMITS` 상향이 필요하고 이는 frozen contract 변경(`pipeline-plan-consistency.test.ts:108-128`).

---

## 5. 8.4.0에서 제외된 것 (되살리려면 별도 결정 필요)

- **wiring(D)·verification(E) 대부분·SSOT lineage 분석기.** §2.2 #0 때문. 데이터가 0건이라 규칙이 unfalsifiable해짐. 되살리려면 align이 `contextGraphExtractors()`로 컴파일하도록 단일 extractor 단언을 푸는 **Align 계약 변경**이 필요.
- `ssot_domains` 어댑터. `canonicalSsotSources()`의 `derived[]`가 경로 형태가 아님 — `worker inboxes`, `implementation notes` 같은 값이 섞여 매핑 불가. ~80–120줄 신규.
- 모듈 단위 `protected` 유도. `isProtectedGate`는 gate만 커버, module 노드엔 risk 필드가 없음.
- `generation-manifest.json`. 오늘 존재하지 않고 Atlas 전제조건도 아님. "one bound generation"은 이미 `snapshot_hash` + `publication.artifact_sha256` 두 메커니즘으로 동작 중.
- 두 line-budget 권위(`CODE_STRUCTURE_THRESHOLDS` 3000 ↔ `architecture-budgets.split_review_lines` 3000) 일치 단언. 지금은 우연히 같고 아무것도 강제하지 않음.

---

## 6. 미해결 — 사람 결정 필요

Wave 2 시작 전:

1. **`.mmd` 추적 vs ignore의 최종 확정.** 나는 §6.2 근거로 ignore로 정했으나, 전례인 `code-pack.json`은 tracked이고 `code-pack-head-freshness` 게이트가 stale 사본을 잡아주기 때문에 성립함. 재확인 권장.
2. **Atlas 게이트가 `ALWAYS_ON_GATES` / `REQUIRED_FOR_PUBLISH`에 들어가는가.** `architecture:guard`는 둘 다 들어있음. 변경 파일과 무관하게 매 publish 실행하는 비용이 실재.

Wave 3 시작 전:

3. **`$GX`가 자기 게이트에서 면제되는가.** `routeNeedsEngineeringSanityReview`(`runtime-core.ts:1619`)는 GX를 면제함. Atlas가 gx view-model 위에 있으므로 "GX는 항상 실행" 규칙과 충돌.
4. **새 게이트 id가 reflection 무효화 면제(`runtime-gates.ts:539-541`)에 들어가는가.** 안 넣으면 게이트 실패마다 verify→reflection 재작성→재verify churn 발생.

---

## 7. Atlas와 무관한 기존 버그 (건드리지 말 것)

**`$GX`/`$DB` tiny-change가 이미 자기 한도를 초과함.** base `5fb6fb70`에서 실측: `$GX README 오타 고쳐줘` → limit 1, count 2, `validatePipelinePlan().ok === false`, `['gate_budget.blocking_gate_limit_exceeded:2>1']`. 원인은 `buildPipelineStages`(`runtime-core.ts:562`)가 `gateProfile`을 무시하고 `specializedRoute`만 보고 스테이지 2개를 push하는 것. **Atlas 작업 안에서 고치지 말 것** — 별도 결정 사항(tiny-change 한도 상향 vs 특수 라우트의 profile 승급). 단 Wave 3에 직접 영향.

**`architecture:check`가 release DAG에 없음.** 유일한 파일 크기 예산 강제 수단인데 `.github/workflows/publish-npm.yml`에만 있음. release DAG가 초록이어도 예산에 대해 아무것도 증명하지 않음.

---

## 8. 환경 함정 (실제로 당한 것들)

1. **릴리스 verify는 nvm `v24.0.2`로 돌려야 한다.** `package.json`의 `test:release`가 맨 `node`라서 npm 라이프사이클 안에서는 PATH의 nvm v24.0.2로 풀린다. `/opt/homebrew/bin/node`(v25.9.0)로 verify하면 `canonical_test_proof_node_version_mismatch`로 **거짓 실패**한다. 이걸로 40분 날렸음. `npm publish`의 `prepublishOnly`도 라이프사이클이라 v24.0.2로 풀리므로 그대로 통과한다.
2. **대화형 셸의 `node`/`npm`은 깨진 zsh shim이다.** 직접 호출은 `/opt/homebrew/bin/node|npm` 절대경로로.
3. **NUL 바이트 파일 3개.** `src/core/naruto/context-graph-advisor.ts`, `context-graph/query/explain.ts`, `context-graph/extractors/evidence/shared.ts`. BSD `grep`이 **exit 0으로 아무것도 반환 안 함**. 모든 sweep은 `grep -a`로.
4. **셸 이중따옴표 안의 백틱.** baseline 캡처 중 `` `sks align run` ``이 명령 치환으로 **실제 실행**됐다. 그래프가 stale→fresh로 바뀌고 tracked 생성물 2개가 재작성됨. 되돌리지 않고 유지했고(되돌리면 매니페스트가 디스크 스냅샷과 어긋나 `meta_mismatch`), `baseline.json`의 `capture_events`에 기록했다. **긴 JSON은 셸 문자열 대신 `.mjs` 파일로 쓸 것.**

---

## 9. 참고 위치

| 무엇 | 어디 |
|---|---|
| Baseline ledger | `.sneakoscope/work-orders/architecture-atlas/baseline.json` |
| 설계 문서 (결정·수정안·Wave 계획·exit receipt 14개·미해결 8건) | `.sneakoscope/work-orders/architecture-atlas/design-decisions.md` |
| 재감사 원본 | 워크플로 run `wf_2b49bb44-630` |
| 설계 프로브 원본 | 워크플로 run `wf_0ac7d6af-453` |
| Wave 1 구현 | 워크플로 run `wf_cce4675e-caf` |
| 모델 카탈로그 배선도 (8.3.3) | `docs/model-catalog-wiring.md` |

설계 문서는 세션 임시 디렉터리에서 `.sneakoscope/work-orders/architecture-atlas/design-decisions.md`로 복사해 두었다. 워크플로 run 산출물 자체는 세션 로컬이므로 유실 가능하지만, 결론은 전부 이 디렉터리 안에 남아 있다.
