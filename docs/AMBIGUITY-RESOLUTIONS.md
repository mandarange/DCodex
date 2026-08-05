# Sneakoscope Codex — Ambiguity & Contradiction Resolutions

작성 시작: 2026-08-05  
범위: 전체 제품 계약  
방식: 질문 → 결정 → 이 문서에 누적  
우선순위: ① 제품 주장 → ② 문서 충돌 → ③ 코드·스키마·버전 불일치

---

## Process

| ID | 결정 | 상태 |
| --- | --- | --- |
| PROC-1 | 단일 원장 경로: `docs/AMBIGUITY-RESOLUTIONS.md` | decided |
| PROC-2 | 범위: 전체 제품 계약 | decided |
| PROC-3 | 항목 형식: 주제 ID / 모순·모호 / 증거 / Q→결정 / 확정 계약 / 후속 / 상태 | decided |
| PROC-4 | 우선순위: 제품 주장 → 문서 충돌 → 코드·스키마·버전 (전부, 이 순서) | decided |
| PROC-5 | 모호점 인터뷰는 Round 10에서 종료; 이후 개정은 명시적 추가만 (X7) | decided |

항목 상태 값: `open` | `decided` | `needs-code` | `wont-fix`

---

## Round 1 — 제품 주장 (Product claims)

### P1. 공식 제품 문장

- **모순·모호:** 제품 한 줄 정의가 마케팅/README/내부 문서에서 흔들릴 수 있음.
- **증거:** `README.md` marketing block.
- **Q→결정:** 공식 제품 문장으로 고정할지? → **고정.**
- **확정 계약:** Sneakoscope Codex (`sks`) is an open-source trust layer for Codex CLI and ChatGPT Desktop. It coordinates bounded AI coding agents, records machine-verifiable evidence, preserves project memory, and blocks release claims that are not supported by current tests or artifacts. Search visibility outcomes are measured separately; SKS does not promise rankings or traffic.
- **후속:** 다른 one-liner가 있으면 이 문장으로 수렴; 의도적 변형은 이 원장에 예외로 기록.
- **상태:** `decided`

### P2. SKS 소유 vs 호스트 소유

- **모순·모호:** mission/evidence/gates vs credential/model/workspace 경계와 Menu Bar·codex-lb·native Goal 예외가 문서에 흩어져 있음.
- **증거:** `README.md` adapter/ownership guidance; Goal/native-surface notes.
- **Q→결정:** 합리적으로 고정 위임 → 아래 계약.
- **확정 계약:**
  - **기본:** SKS는 mission·evidence·gates(및 release claim blocking)를 소유한다. 호스트(Codex CLI / ChatGPT Desktop)는 credential·model policy·workspace를 소유한다.
  - **예외/명확화:**
    1. Persisted Goal의 유일한 소유자는 Codex native Goal이다. SKS는 Goal state나 Goal fallback loop를 쓰지 않는다. (P3와 동일)
    2. Capability probe는 호스트가 *할 수 있는지*의 측정 증거일 뿐, native surface(Fast, image, Browser/Computer Use, voice, plugins 등)를 SKS가 켜거나 대신 소유한다는 뜻이 아니다.
    3. Menu Bar / Center는 설치·상태·업데이트 induce와 안전한 status 경로를 담당할 수 있으나, mission/evidence의 진실원이 아니다.
    4. Adapter(예: codex-lb)는 호스트 credential/session을 가로채 재작성하거나 tool output을 위조하지 않는다.
    5. Managed skills/hooks는 SKS가 호스트 환경에 설치하는 제어 표면이지만, 런타임 모델·자격증명 결정은 호스트 소유로 남는다.
- **후속:** README/adapter ownership 문장을 P2에 맞출지 — Round 2에서 범위 확정하지 않음; 잔여 `needs-code` 백로그.
- **상태:** `decided`

### P3. Goal 단일 소유자

- **모순·모호:** SKS mission/loop와 Codex Goal이 이중 소유처럼 읽힐 여지.
- **증거:** `README.md` “Codex native Goal is the only persisted owner… SKS writes no Goal state or fallback loop.”
- **Q→결정:** Codex native Goal만? → **예.**
- **확정 계약:** Persisted goal의 유일한 소유자는 Codex native Goal이다. SKS는 Goal state를 쓰지 않고 Goal fallback loop를 만들지 않는다.
- **후속:** Goal-like 상태를 쓰는 경로가 있으면 제거 또는 이 원장에 명시적 예외.
- **상태:** `decided`

### P4. Completion 의미 (light 경로 완화)

- **모순·모호:** “검사 없이 완료 주장 금지”가 전 표면에 동일한지 불명.
- **증거:** AGENTS / engineering directive; Answer·DFix light pipelines.
- **Q→결정:** Answer / DFix 같은 light 경로만 완화? → **예.**
- **확정 계약:** 일반·고위험·릴리즈 경로의 완료 주장은 관련 검사 또는 “검사가 불필요함”의 명시적 정당화가 필요하다. Answer·DFix 등 light 경로만 완화된 검증(저비용 확인 또는 문서화만)으로 닫을 수 있다. Light 경로의 완화가 full-route/release 완료를 대체하지 않는다. Light 경로 목록은 C6.
- **후속:** C6 목록을 게이트/라우트 표와 대조.
- **상태:** `decided`

### P5. Codex 버전 SSOT

- **모순·모호:** README의 version-agnostic/capability 서술 vs 저장소의 버전별 스키마·compat 문서.
- **증거:** `README.md` capability-probe language; `schemas/codex/`, `docs/codex-*-compat.md`, release notes.
- **Q→결정:** (c) 최신 stable 하나만 SSOT, 과거는 retired? → **(c).** C1에서 고정 버전 문자열 자체를 두지 않는 쪽으로 정교화.
- **확정 계약:** 제품·문서·스키마의 Codex 호환 SSOT는 **항상 현재 최신 stable 하나**이다. 과거 버전 전용 표면은 retired이며 되살리지 않는다. 제품 계약에 `0.x.y` 같은 **고정 버전 문자열을 SSOT로 두지 않는다**(C1). Capability probe는 *그 최신 stable 호스트에서 무엇이 되는가*를 측정한다.
- **후속:** D1·C1–C3 정렬. 스키마/문서는 교체(replace)이지 버전 아카이브 축적이 아님.
- **상태:** `decided` (정렬 작업은 `needs-code`)

### P6. TriWiki 제품 역할

- **모순·모호:** TriWiki가 기억 SSOT인지, 코드 탐색 인덱스인지, 둘 다인지.
- **증거:** handoff `docs/NEXT-AI-HANDOFF-8.0.5-TRIWIKI-CLEANUP.md`; architecture docs; README search `context` mode.
- **Q→결정:** (c) 둘 다(역할 분리)? → **(c).**
- **확정 계약:**
  - TriWiki는 **역할이 분리된 두 기능**을 가진다: (1) 코드 탐색 인덱스, (2) 프로젝트 기억/주장의 구조화 저장.
  - **권위 순서:** `context-graph.json`이 전체 코드 탐색 권위이다. `context-pack.json`과 managed `AGENTS.md` projection은 빠른 초기 탐색용 bounded projection이며 전체 파일 목록을 대신하지 않는다. Memory(`.sneakoscope/memory` 등)는 기억/주장 평면이며 코드 인덱스를 대체하지 않는다. 위험·낮은 trust claim은 소스에서 hydrate한다.
- **후속:** cleanup/align 문서·스킬을 P6·D3에 맞출지 — 잔여 `needs-code` 백로그.
- **상태:** `decided`

### P7. “실패가 올바른 답”

- **모순·모호:** blocked mission / gate 실패를 성공처럼 보이게 만드는 우회 유혹.
- **증거:** `README.md` “Let the gates fail… A blocked mission with blockers is a correct answer.”
- **Q→결정:** 제품 원칙인가? → **맞다.**
- **확정 계약:** 게이트 실패와 blocker가 있는 blocked mission은 올바른 결과이다. 안전 플래그를 끄거나 증거를 위조·생략해 성공처럼 보이게 만들지 않는다. 사용자/릴리즈 경로에도 이 원칙의 예외를 두지 않는다. (Light 경로의 *검증 완화*(P4)는 “실패를 성공으로 위장”과 다르다.)
- **후속:** 우회를 암시하는 문서/스크립트가 있으면 Round 2–3에서 표시.
- **상태:** `decided`

---

## Round 2 — 문서 충돌

### D1. README version 서술 vs P5/C1

- **모순·모호:** README “version-agnostic” vs 최신-stable-SSOT.
- **증거:** `README.md`; P5; C1.
- **Q→결정:** (a) P5(c)에 맞게 재작성? → **(a).**
- **확정 계약:** README는 “최신 stable이 호환 SSOT이고, capability probe는 그 호스트에서의 실측”으로 재작성한다. 고정 버전 번호를 제품 SSOT로 적지 않는다(C1). 구 호스트 best-effort 매트릭스 서술은 제품 SSOT가 아니다.
- **후속:** README 해당 문단 수정 → `needs-code`.
- **상태:** `decided`

### D2. “cleanup” 다의어

- **모순·모호:** TriWiki / agent / doctor / harness conflicts 등이 모두 cleanup.
- **증거:** commands, doctor, handoff docs.
- **Q→결정:** (a) 경로별 용어 강제 분리? → **(a).**
- **확정 계약:** 사용자·문서·명령 표면에서 cleanup을 경로별로 구분한다. 예: `triwiki-cleanup` (`$sks-cleanup` / TriWiki 빈 상태), `harness-conflicts-cleanup`, agent cleanup, doctor install cleanup 등. 범용 “cleanup” 단독 사용은 금지에 가깝게 피하고, 불가피하면 이 원장 의미표를 가리킨다.
- **후속:** 명령·스킬·문서 개명/표기 정렬 → `needs-code`.
- **상태:** `decided`

### D3. cleanup vs align 공식 서술

- **모순·모호:** align이 cleanup 이후에만 가능하다는 오해.
- **증거:** `docs/NEXT-AI-HANDOFF-8.0.5-TRIWIKI-CLEANUP.md`.
- **Q→결정:** align은 cleanup receipt 없이 언제든 전체 재구축 — 유일한 공식 서술? → **예.**
- **확정 계약:** `$sks-cleanup`(triwiki-cleanup)과 `$sks-align`은 독립이다. align은 cleanup receipt를 요구하지 않으며, TriWiki가 없거나/잘못되었거나/정상인 모든 경우 현재 저장소 소스만으로 전체 재구축한다.
- **후속:** 스킬·CLI help·관련 문서에 이 문장만 공식 서술로 유지 → `needs-code`.
- **상태:** `decided`

### D4. 구 Codex compat 문서

- **모순·모호:** 버전별 `docs/codex-*-compat.md` 잔존/삭제 혼재.
- **증거:** git status / docs tree; P5; C1.
- **Q→결정:** (a) 최신 하나만 남기고 나머지 repo에서 제거? → **(a).**
- **확정 계약:** 현행 Codex 호환 문서는 **하나**만 둔다. 과거 버전 전용 compat 문서는 아카이브 디렉터리로 옮기지 않고 저장소에서 제거한다. 문서에도 고정 버전을 제품 SSOT로 박지 않는다(C1); 필요 시 “current latest stable”과 실측 probe를 가리킨다.
- **후속:** 잔존 compat 정리 → `needs-code`.
- **상태:** `decided`

### D5. 제품 문장 표면 일치

- **모순·모호:** README / npm / 사이트 / Menu Bar one-liner 불일치 가능.
- **증거:** P1.
- **Q→결정:** (a) 모두 P1과 문자 일치? → **(a).**
- **확정 계약:** 공개 제품 한 줄 정의는 P1 문장과 **문자 일치**해야 한다. 짧힌 파생 카피는 허용하지 않는다.
- **후속:** 표면별 문자열 스캔·동기화 → `needs-code`.
- **상태:** `decided`

---

## Round 3 — 코드·스키마·버전

### C1. Codex SSOT에 고정 버전 문자열을 두지 않음

- **모순·모호:** `0.146.0` 같은 숫자를 문서/스키마 SSOT로 박을지.
- **증거:** P5(c); schemas/release pins.
- **Q→결정:** 항상 최신이므로 고정 버전 문자열이 애초에 없는 편이 자연스럽다 → **채택.**
- **확정 계약:** 제품 계약의 Codex SSOT는 **“current latest stable”** 개념이다. README·제품 카피·호환 문서에 특정 `0.x.y`를 SSOT로 고정하지 않는다. 저장소 artifact(스키마 디렉터리 등)는 최신 하나만 교체 유지하며(C2), 그 디렉터리명이 일시적으로 버전을 닮더라도 제품 문장이 그 숫자를 SSOT로 선포하지 않는다.
- **후속:** 고정 버전을 SSOT처럼 읽는 문서/게이트 카피 제거 또는 재작성 → `needs-code`.
- **상태:** `decided`

### C2. app-server 스키마 디렉터리 정책

- **모순·모호:** `schemas/codex/app-server-*` 다중 버전 공존.
- **증거:** schemas tree; D4; C1.
- **Q→결정:** (a) 최신 디렉터리 하나만 유지, 나머지 삭제? → **(a).**
- **확정 계약:** `schemas/codex/app-server-*`는 **최신 하나**만 유지한다. 이전 디렉터리는 삭제한다. “직전 1개 마이그레이션용 유지”는 하지 않는다.
- **후속:** 스키마 트리 정리 + 참조 경로 갱신 → `needs-code`.
- **상태:** `decided`

### C3. package / release / Menu Bar 버전 일치

- **모순·모호:** 표면마다 다른 Codex/관련 버전 숫자.
- **증거:** package.json, release gates, Menu Bar probes; C1.
- **Q→결정:** (a) 전부 C1과 동일, 불일치 = gate fail? → **(a).**
- **확정 계약:** package·release gates·Menu Bar 등 권위 표면이 서로 다른 “현재 Codex/호환” 숫자를 말하면 **gate fail**이다. 모두 C1(항상 동일한 current latest)을 가리켜야 하며, 고정 SSOT 숫자를 제품 카피에 추가하는 방식으로 맞추지 않는다 — **서로 일치하는 실측/핀**이어야 하고 불일치는 실패다.
- **후속:** 불일치 검출 게이트 강화 또는 기존 게이트에 연결 → `needs-code`.
- **상태:** `decided`

### C4. cleanup / align 표면 등록

- **모순·모호:** core 구현만 있고 CLI/dollar/packed 미등록 가능.
- **증거:** handoff “이 파일 범위 밖의 남은 통합”.
- **Q→결정:** (a) 등록·검증까지 끝내야 릴리즈? → **(a).**
- **확정 계약:** 8.0.5(또는 해당 기능이 들어가는 릴리즈)에서 `$sks-cleanup` / `$sks-align`은 route registry·CLI manifest·dollar-command·packed black-box 검증까지 완료되어야 릴리즈 가능하다. core만으로는 부족하다.
- **후속:** 등록 + packed 검증 → `needs-code`.
- **상태:** `decided`

### C5. TriWiki cleanup 복구 없음

- **모순·모호:** backup/quarantine/restore 여지.
- **증거:** handoff cleanup 계약.
- **Q→결정:** (a) 영구 삭제·미보존이 코드 불변식? → **(a).**
- **확정 계약:** triwiki-cleanup 성공 경로에서 backup·quarantine·restore용 이전 세대를 남기지 않는 것이 **불변식**이다. 위반 시 fail한다. 실패가 영구 삭제 시작 전이면 임시 이동/projection을 원상 복구한다(성공 후 복구 경로와 다름).
- **후속:** 테스트/게이트가 이 불변식을 계속 강제하는지 확인 → `needs-code` if gaps.
- **상태:** `decided`

### C6. Light 경로 목록 (P4)

- **모순·모호:** 완료 완화 대상 집합.
- **증거:** P4.
- **Q→결정:** (b) Answer + DFix + Help/status류 read-only? → **(b).**
- **확정 계약:** Light 완료 완화 대상은 **Answer, DFix, 그리고 Help/status류 read-only 경로**이다. 그 밖의 실행·변경·릴리즈 경로는 full 완료 계약(P4)을 따른다.
- **후속:** 라우트/게이트 표에 light 집합을 명시 → `needs-code`.
- **상태:** `decided`

---

## Needs-code backlog (구현 추적)

상태: `done` = 이번 정렬에서 코드/문서 반영됨 · `partial` = 핵심 반영, 잔여 검증 가능 · `needs-code` = 아직 미완

| ID | 요약 | 출처 | 상태 |
| --- | --- | --- | --- |
| NC-1 | README를 D1/C1 계약으로 재작성 | D1, C1 | done |
| NC-2 | cleanup 경로별 용어 분리(명령/스킬/문서) | D2 | done |
| NC-3 | align 독립 공식 서술을 스킬·help·문서에 단일화 | D3 | done |
| NC-4 | 구 compat 문서 제거, 현행 호환 문서 하나 | D4 | done |
| NC-5 | 공개 표면 제품 문장 = P1 문자 일치 | D5 | done |
| NC-6 | app-server 스키마 최신 하나만 유지 | C2 | done |
| NC-7 | package/release/Menu Bar 버전 불일치 gate fail | C3 | done |
| NC-8 | cleanup/align CLI·dollar·packed 등록·검증 | C4 | done |
| NC-9 | triwiki-cleanup 무복구 불변식 테스트/게이트 확인 | C5 | partial |
| NC-10 | light 경로 집합(Answer/DFix/Help·status) 문서·게이트 반영 | C6 | done |
| NC-11 | ownership/TriWiki 권위 문서의 P2·P6 정렬 | P2, P6 | done |
| NC-12 | Naruto 모델 라우팅에 Luna Max(기계적 타이핑) 포함·문서/스킬 정렬 | R1 | done |
| NC-13 | 릴리즈 최소 증거를 release gates로 문서화; 나머지는 권장 | R2 | done |
| NC-14 | DB read-only/인가 계약을 DB 라우트에 한정해 문서화 | R3 | done |
| NC-15 | SEO/GEO를 제품 계약 밖 내부 도구로 표기·마케팅 약속 금지 유지 | R4 | done |
| NC-16 | 에이전트 `sks doctor --fix` 금지 절대 계약 표기 통일 | R5 | done |
| NC-17 | Fast/Computer Use 등: Codex 공식 표면 consume-only; Local LLM은 opt-in 부가; SKS 재구현 금지 | R6 | done |
| NC-18 | installed harness 변경은 doctor --fix / 명시적 install·update만 | R7 | done |
| NC-19 | subagent 중첩 금지 절대 계약을 문서·게이트에 고정 | S1 | done |
| NC-20 | mission retention: 완료 후 미션 파일 삭제 + “삭제=미완료” 오판 무한루프 방지 | S2 | done |
| NC-21 | `$sks-wiki` refresh를 align(wiki/pack 포함)으로 수렴·단일화 | S3 | done |
| NC-22 | 설치 SSOT = npm `@latest`; PATH/Menu Bar를 그에 맞추고 불일치는 fail | S4, C3 | done |
| NC-23 | harness-conflicts-cleanup을 triwiki-cleanup과 완전 분리(문서·백업 정책) | S5 | done |
| NC-24 | trusted-project: 로컬 개인 기본 on 가능; SKS 엔진 사용자 수정 불가; Codex config는 수정 가능 | S6 | done |
| NC-25 | Context7/vendor docs 우선을 스택 변경 경로에 강제 | S7 | done |
| NC-26 | Honest Mode: 매 단계 반복 금지 → 작업 일괄 후 최종 1회 + 미비점만 재시도 | T1 | done |
| NC-27 | 시각 증거는 Codex 공식 imagegen만; 위조/플레이스홀더 금지 | T2 | done |
| NC-28 | Design/PPT/GX/Autoresearch를 제품 계약 밖 내부·옵션으로 표기 | T3 | done |
| NC-29 | Center/Menu Bar = UX only; 내부는 CLI 호출로 단일화 | T4 | partial |
| NC-30 | 모호 스레드: 재시도/복구 후 동일 스레드 계속 허용 | T5 | done |
| NC-31 | 비밀 fail-closed; evidence/로그에 비밀 금지; 자체 credential fallback 금지 | T6 | done |
| NC-32 | full 경로 완료 시 자동 커밋 허용; push는 명시 요청만 | T7 | done |
| NC-33 | 플랫폼: macOS 완전 지원; Linux/Windows CLI best-effort 문서화 | U1 | done |
| NC-34 | SKS 버전을 엄격 semver 계약이 아닌 마케팅 버전으로 문서화 | U2 | done |
| NC-35 | 제품 업데이트 채널은 `@latest`만; next/beta 비제품화 | U3 | done |
| NC-36 | 원격 텔레메트리/사용 분석 없음(기본 off) 명시 | U4 | done |
| NC-37 | 테스트 철학=주경로·경계·credible failure; 저가치 매트릭스 금지 정렬 | U5 | done |
| NC-38 | `$sks-loop`/SKS 지속 루프 제거(Codex Goal과 중복) | U6, P3 | done |
| NC-39 | release proof: 필수만·레포 경량 유지·주기적 정리 | U7 | partial |
| NC-40 | 이름 삼각형 문서화: Sneakoscope Codex / `sks` / npm `sneakoscope` | V1 | done |
| NC-41 | plugin marketplace = npm `@latest`와 동일 강제; 불일치 fail | V2, S4 | done |
| NC-42 | `$sks-research`를 제품 계약 밖 내부·옵션으로 표기 | V3 | done |
| NC-43 | Menu Bar/Center a11y를 제품 요구·회귀 방지로 반영 | V4 | partial |
| NC-44 | 오프라인 비약속; 온라인(npm·Codex)이 정상 경로임을 명시 | V5 | done |
| NC-45 | 성능 SLA/벤치 숫자 제품 약속 제거·내부 측정만 | V6 | done |
| NC-46 | Codex 호스트 업그레이드: SKS는 유도·검사·fail; 실행은 사용자/Codex | V7 | done |
| NC-47 | managed skill 글로벌 우선·stale mismatch 비보고 절대 계약 | W1 | done |
| NC-48 | Codex CLI와 ChatGPT Desktop을 동등 1급 호스트로 문서화 | W2 | done |
| NC-49 | Cursor 등 비공식 호스트는 best-effort/비약속으로 명시 | W3 | done |
| NC-50 | UI/문서 언어 SSOT = 영어 | W4 | done |
| NC-51 | 타사 MCP는 호스트/사용자 영역; SKS 비보증 명시 | W5 | done |
| NC-52 | `sks uninstall`로 SKS 관련 셋업·파일 완전 제거 | W6 | partial |
| NC-53 | 동시 다수 SKS 인스턴스 = best-effort (비약속) | W7 | done |
| NC-54 | 외부 기여 welcome(PR/이슈) 문서화 | X1 | done |
| NC-55 | multi-agent: Codex 공식 시스템 wrap-only; 없으면 제품 미완성 | X2, R6 | done |
| NC-56 | review/security/bugbot = 릴리즈 핵심; 말미 1회 + 미비점 루프 (T1과 동일 리듬) | X3 | done |
| NC-57 | 기본 최소 로그; verbose/debug는 명시 플래그 | X4 | done |
| NC-58 | 공식 지원 = GitHub Issues | X5 | done |
| NC-59 | align cap/binary/oversized = fail-closed 유지 | X6 | done |
| NC-60 | 이 원장을 제품 계약 SSOT로 문서/코드 정렬의 기준으로 사용 | X7 | done |

Projection: [PRODUCT-CONTRACT.md](PRODUCT-CONTRACT.md).

---

## Round 4 — 라우트 · 릴리즈 · 안전 · 부가 표면

### R1. Naruto 모델 라우팅

- **모순·모호:** Terra/Sol만으로는 기계적 타이핑 슬라이스 라우팅이 불명.
- **증거:** `README.md` model routing; AGENTS routing notes.
- **Q→결정:** (c) Luna Max를 혼동 없는 디테일 타이핑 작업용으로 추가? → **채택.**
- **확정 계약:** Naruto 슬라이스 라우팅 제품 계약은 다음과 같다.
  - **Luna Max:** 혼동 여지가 없는, 진짜 디테일한 타이핑 수준(기계적·범위가 극히 좁고 판단이 거의 불필요한) 작업
  - **Terra Max:** read-heavy 탐색·컨텍스트
  - **Sol High:** 일반 구현
  - **Sol Max:** 고위험·집중 판단·최종 리뷰만
- **후속:** README/스킬/라우터 문구 정렬 → `needs-code` (NC-12).
- **상태:** `decided`

### R2. 릴리즈 최소 증거

- **모순·모호:** typecheck/focused/full gates/dry-run 중 무엇이 필수인지.
- **증거:** handoff release notes; release-gates.
- **Q→결정:** (b) release gates만 필수, 나머지는 권장? → **(b).**
- **확정 계약:** “출시 가능”의 **필수** 증거 집합은 **release gates**이다. typecheck·focused tests·package dry-run 등은 권장이며, 필수 집합을 대체하거나 필수에 자동 편입하지 않는다(별도 원장 개정 없이).
- **후속:** release-readiness 문서에 필수 vs 권장 분리 → `needs-code` (NC-13).
- **상태:** `decided`

### R3. DB / 파괴적 외부 동작

- **모순·모호:** 전 제품 절대 계약인지 DB 라우트 한정인지.
- **증거:** AGENTS safety; `$sks-db` / `$sks-mad-sks`.
- **Q→결정:** (b) DB 라우트에만 적용, 일반 파일 변경은 별도? → **(b).**
- **확정 계약:** 기본 read-only 및 라이브 mutation의 명시적 스코프 인가 요구는 **DB 라우트(및 그 SQL-plane / MAD 경로)**에 적용된다. 일반 워크스페이스 파일 변경은 이 DB 계약의 대상이 아니며, 해당 라우트·게이트의 별도 규칙을 따른다.
- **후속:** DB safety 문서에 적용 범위 명시 → `needs-code` (NC-14).
- **상태:** `decided`

### R4. Search visibility (SEO/GEO)

- **모순·모호:** SEO/GEO가 제품 핵심 약속인지 내부 도구인지.
- **증거:** P1 (순위·트래픽 비약속); SEO/GEO skills.
- **Q→결정:** (b) 내부 도구, 제품 계약 밖? → **(b).**
- **확정 계약:** SEO/GEO 라우트는 **제품 핵심 계약 밖의 내부 도구**이다. P1의 “순위·트래픽 비약속”은 유지하되, SEO/GEO 완료를 trust-layer 제품 완료와 동일시하지 않는다.
- **후속:** 마케팅/README에서 SEO/GEO를 핵심 기능처럼 읽히지 않게 정리 → `needs-code` (NC-15).
- **상태:** `decided`

### R5. `sks doctor --fix` 실행 주체

- **모순·모호:** 에이전트가 doctor --fix를 돌릴 수 있는지.
- **증거:** AGENTS safety block.
- **Q→결정:** (a) 절대 계약? → **(a).**
- **확정 계약:** 에이전트는 `sks doctor --fix`를 **직접 실행하지 않는다.** 수리가 필요하면 사용자에게 본인 터미널에서 실행하도록 안내하고 확인을 기다린다. 문서·스킬·에이전트 지시 모두 이 절대 계약을 따른다.
- **후속:** 위반을 암시하는 문서/스크립트 제거 또는 경고 → `needs-code` (NC-16).
- **상태:** `decided`

### R6. Local LLM / Fast / Computer Use 등

- **모순·모호:** 부가 모드인지 핵심인지, SKS 재구현인지 호스트 consume인지.
- **증거:** P2 native-surface notes; Fast/CU/local-llm skills.
- **Q→결정:** Local LLM만 제외(부가). 나머지(Fast, Computer Use 등 Codex 공식 제공 표면)는 핵심이나 **SKS가 구현한 형태면 안 되고, Codex가 제공하는 것을 가져다 쓰는 형태**여야 함.
- **확정 계약:**
  1. **Local LLM**은 핵심 trust-layer 계약 밖의 **opt-in 부가 표면**이다. 꺼져 있어도 핵심 계약은 성립한다.
  2. **Fast mode, Computer Use, 기타 Codex가 공식적으로 제공하는 native 표면**은 제품이 의존·조율할 수 있는 **핵심 호스트 능력**이다.
  3. 다만 SKS는 이를 **재구현·대체 구현하지 않는다.** 공식 Codex 표면을 **consume / bridge / gate**할 뿐, 평행 구현을 제품 경로로 두지 않는다. (P2: capability probe ≠ SKS가 native surface를 소유·토글한다는 뜻과 정합.)
- **후속:** 재구현/평행 경로가 있으면 제거 또는 비제품으로 격리; 문서에 consume-only 명시 → `needs-code` (NC-17).
- **상태:** `decided`

### R7. Installed harness 불변성

- **모순·모호:** 절대 불변 vs install/doctor 예외.
- **증거:** AGENTS “Installed harness files remain immutable outside the Sneakoscope engine source repository.”
- **Q→결정:** (b) `doctor --fix` / 명시적 install·update만 예외? → **(b).**
- **확정 계약:** 엔진 소스 저장소 밖에서 설치된 하네스 파일은 기본적으로 불변이다. **예외:** 사용자가 명시적으로 실행하는 `sks doctor --fix`, 그리고 명시적 install·update 경로만이 해당 파일을 변경할 수 있다. 에이전트·임의 스크립트의 직접 변조는 금지한다. (R5: 에이전트는 doctor --fix를 대신 실행하지 않는다.)
- **후속:** immutability/예외 문구를 install·doctor 문서에 통일 → `needs-code` (NC-18).
- **상태:** `decided`

---

## Round 5 — 미션 · 증거 · 설치 · 검색 · 충돌

### S1. Subagent 중첩

- **모순·모호:** 호스트가 허용하면 중첩 가능한지.
- **증거:** AGENTS parent-owns-decomposition rule.
- **Q→결정:** (a) 절대 계약? → **(a).**
- **확정 계약:** 서브에이전트 중첩은 **절대 금지**이다. 부모만 분해·통합·검증·최종 답을 소유한다. 위반은 잘못된 실행이다.
- **후속:** 문서·스킬·게이트에 절대 계약 표기 → `needs-code` (NC-19).
- **상태:** `decided`

### S2. Mission / evidence 수명

- **모순·모호:** 영구 보관 vs 용량 vs 완료 판정.
- **증거:** mission dirs; retention cleanup.
- **Q→결정:** (b) 기본 보관 + 명시적 retention/cleanup + **완료 후 미션 파일 삭제(용량)** 단 **삭제로 미완료 오판 → 무한루프 절대 금지.**
- **확정 계약:**
  1. Mission/evidence는 기본적으로 보관되며, **명시적 retention/cleanup 정책**으로만 삭제한다.
  2. 미션이 **완료된 뒤에는** 미션 파일을 삭제하여 용량 오버플로우를 방지해야 한다.
  3. 삭제 또는 부재를 “미션 미완료”로 오판하여 재실행·재생성 **무한루프에 들어가는 것은 절대 금지**다. 완료 판정은 삭제 전 확정 상태(또는 삭제와 독립적인 completion receipt)에 묶여야 한다.
- **후속:** completion receipt와 retention 순서 불변식 구현/테스트 → `needs-code` (NC-20).
- **상태:** `decided`

### S3. `$sks-wiki` refresh vs `$sks-align`

- **모순·모호:** wiki 갱신과 align 재구축이 이중 경로인지.
- **증거:** wiki/align skills; D3(cleanup⊥align); P6 권위 순서.
- **Q→결정:** (b) align이 wiki/pack까지 포함해 하나로 수렴? → **(b).**
- **확정 계약:** 코드 인덱스·wiki·pack 갱신은 **`$sks-align` 하나로 수렴**한다. align이 wiki/pack 생성을 포함한다. 별도 `$sks-wiki` refresh를 제품의 평행 진실원으로 두지 않는다(별도 명령이 남더라도 align의 진입점/별칭이거나 폐기 대상). D3(cleanup과 align 독립)는 유지한다.
- **후속:** wiki 경로를 align으로 병합·문서/스킬/CLI 정리 → `needs-code` (NC-21). NC-3와 함께 서술 단일화.
- **상태:** `decided`

### S4. Install / update 권위

- **모순·모호:** PATH `sks` vs Menu Bar stamp vs npm `@latest`.
- **증거:** README install; Menu Bar; C3 버전 일치.
- **Q→결정:** (c) npm registry `@latest`가 SSOT? → **(c).**
- **확정 계약:** “설치된 SKS가 무엇이어야 하는가”의 SSOT는 **npm registry `sneakoscope@latest`(및 그 패키지가 가리키는 버전)**이다. PATH의 첫 `sks`, Menu Bar stamped generation 등은 그 SSOT에 **일치해야** 하며, 불일치는 C3에 따라 **gate fail**이다. 이들이 SSOT를 대체하지 않는다.
- **후속:** install/update-check/Menu Bar를 npm `@latest` SSOT에 맞추고 불일치 fail → `needs-code` (NC-22).
- **상태:** `decided`

### S5. Harness conflicts cleanup vs triwiki-cleanup

- **모순·모호:** cleanup 가족으로 묶일지, 완전 별개인지.
- **증거:** D2 용어 분리; `sks conflicts cleanup`; quarantine.
- **Q→결정:** (a) 완전 별개 경로? → **(a).**
- **확정 계약:** harness-conflicts-cleanup과 triwiki-cleanup은 **완전 별개**이다. 이름·문서·백업 정책을 공유하지 않는다. conflicts 경로는 quarantine 백업을 유지할 수 있다. triwiki-cleanup의 무복구 불변식(C5)을 conflicts에 적용하지 않는다.
- **후속:** 문서/명령 표기에서 교차 혼동 제거 → `needs-code` (NC-23).
- **상태:** `decided`

### S6. `--trusted-project` / 안전 플래그 + 엔진 수정 경계

- **모순·모호:** trusted-project 기본값; 사용자가 SKS 엔진을 고칠 수 있는지.
- **증거:** README trusted-project; R7 harness immutability.
- **Q→결정:** (b) 로컬 개인 레포 기본 on 허용 + **일반 사용자의 SKS 엔진 수정은 불가능해야 함** + **Codex `config.toml` 등은 SKS 엔진이 아니므로 수정 가능.**
- **확정 계약:**
  1. `--trusted-project`는 로컬 개인 레포에서 **기본 on을 허용**할 수 있다(운영자/제품 정책으로). “아무 레포에나 켜라”는 무분별 권고는 아니다.
  2. **SKS 엔진**(설치된 sneakoscope/sks 패키지·하네스 엔진 파일)을 일반 사용자가 수정하는 일은 **불가능해야 한다**(제품이 막아야 함). 변경은 R7 예외(명시적 install/update, 사용자가 돌리는 `doctor --fix`)로만.
  3. **Codex 엔진 설정**(예: `config.toml`)은 SKS 엔진이 아니며 **사용자가 수정 가능**해야 한다.
- **후속:** trusted-project 기본값·엔진 vs Codex config 경계를 문서/가드에 반영 → `needs-code` (NC-24).
- **상태:** `decided`

### S7. 외부 문서(Context7 / vendor docs)

- **모순·모호:** 권장인지 제품 강제인지.
- **증거:** AGENTS / answer skill stack-current-docs policy.
- **Q→결정:** (a) Context7 또는 공식 vendor docs가 모델 기억보다 우선 — 제품 계약? → **(a).**
- **확정 계약:** 스택·API·패키지·런타임·플랫폼 버전 관련 작업에서 Context7 또는 공식 vendor docs의 현재 안내가 **모델 기억 기본값보다 우선**한다. 이는 권장이 아니라 **제품 계약**이다.
- **후속:** 해당 경로에 문서 증거 요구를 게이트/스킬에 유지·강화 → `needs-code` (NC-25).
- **상태:** `decided`

---

## Round 6 — 증거 · 부가 라우트 · UI · 실패 복구 · 비밀

### T1. Honest Mode 타이밍

- **모순·모호:** 단계마다 Honest Mode를 돌리면 작업 시간이 불필요하게 길어짐.
- **증거:** sks-honest-mode; full-route closeout 습관.
- **Q→결정:** 매번 하지 말고, 할 일을 최대한 끝낸 뒤 **진짜 마지막에 한 번**; 미비점이 있으면 **그 미비점만** 재시도.
- **확정 계약:** Honest Mode는 중간 단계마다 반복하지 않는다. 가능한 작업을 **일괄 수행한 뒤 최종에 1회** 수행한다. 미비점이 남으면 전체 루프를 다시 돌리지 않고 **미비점만** 재시도한다. 목적은 불필요한 작업 시간 연장을 근본적으로 막는 것이다. (완료 주장의 정직성(P7)은 유지하되, Honest Mode의 *반복 횟수*를 최소화한다.)
- **후속:** 스킬/파이프라인에서 “매 단계 Honest” 유도 제거 → `needs-code` (NC-26).
- **상태:** `decided`

### T2. Imagegen / 시각 증거

- **모순·모호:** 외부 도구·수동 위조 이미지를 제품 증거로 쓸지.
- **증거:** imagegen skills; R6 consume-only.
- **Q→결정:** (a) Codex 공식 imagegen만? → **(a).**
- **확정 계약:** 생성 이미지·주석 등 시각 제품 증거는 Codex 공식 imagegen(`gpt-image-2` 등 호스트가 제공하는 경로)만 인정한다. 플레이스홀더·수동 위조·대체 파일은 제품 증거가 아니다. (R6 consume-only와 동일 계열.)
- **후속:** 증거 규칙 문서/스킬 정렬 → `needs-code` (NC-27).
- **상태:** `decided`

### T3. Design / PPT / GX / Autoresearch

- **모순·모호:** 핵심 제품인지 부가인지.
- **증거:** R4(SEO/GEO=내부); route skills.
- **Q→결정:** (a) 전부 제품 계약 밖 내부/옵션? → **(a).**
- **확정 계약:** Design, PPT, GX, Autoresearch 등 해당 부가 라우트는 **제품 핵심 계약 밖의 내부/옵션 라우트**이다. trust-layer 제품 완료와 동일시하지 않는다. (R4와 같은 취급.)
- **후속:** README/라우트 표에서 핵심과 분리 → `needs-code` (NC-28).
- **상태:** `decided`

### T4. Menu Bar / Center vs CLI

- **모순·모호:** UI가 별도 구현 경로인지, CLI 래퍼인지.
- **증거:** Menu Bar / SKS Center; CLI commands.
- **Q→결정:** (a) CLI가 기능 SSOT + **Center/Menu Bar는 UX용 UI이며 내부는 CLI 호출로 근본 정렬.**
- **확정 계약:**
  1. **CLI가 기능 SSOT**이다. Menu Bar / SKS Center는 상태·업데이트·안전 진입점 등 **기능 부분집합**을 UX로 노출한다.
  2. Center·Menu Bar는 **UX를 위해 존재하는 UI**일 뿐, 내부적으로는 **CLI 방식을 호출**하도록 근본적으로 맞춰야 한다. UI 전용 평행 비즈니스 로직을 제품 경로로 두지 않는다.
- **후속:** Center/Menu Bar → CLI 호출 단일화 점검·리팩터 → `needs-code` (NC-29).
- **상태:** `decided`

### T5. 구조적 모호 스레드

- **모순·모호:** `[No tool output found …]` 등에서 스레드 재사용 절대 금지인지.
- **증거:** README thread-blocking note.
- **Q→결정:** (b) 재시도/복구 후 같은 스레드 허용? → **(b).**
- **확정 계약:** 구조적으로 모호한 스레드는 즉시 폐기 고정이 아니다. **재시도·복구 후 동일 스레드에서 계속하는 것을 허용**한다. (복구 실패 시에만 새 태스크로 이동하는 운영은 가능하나, “모호 = 무조건 새 스레드”를 절대 계약으로 두지 않는다.)
- **후속:** README/가드의 절대 차단 문구를 복구 허용 계약에 맞게 수정 → `needs-code` (NC-30).
- **상태:** `decided`

### T6. 비밀·자격증명

- **모순·모호:** 로컬 secret store vs fail-closed.
- **증거:** README credential fallback ban.
- **Q→결정:** (a) 저장·로그·evidence에 비밀 금지, 없으면 fail-closed? → **(a).**
- **확정 계약:** SKS는 호스트/환경의 비밀을 저장·로그·evidence에 남기지 않는다. 필요 비밀이 없으면 **fail-closed**한다. SKS 자체 자격증명으로의 **조용한 fallback은 금지**한다.
- **후속:** evidence/redaction 경로 점검 → `needs-code` (NC-31).
- **상태:** `decided`

### T7. git commit / push

- **모순·모호:** 자동 커밋 vs 명시 요청만.
- **증거:** commit/push user rules; `$sks-commit*`.
- **Q→결정:** (b) full 경로 완료 시 자동 커밋 허용 + **push는 명시적 요청이 있을 때만.**
- **확정 계약:** Full 경로가 완료되면 **자동 커밋을 허용**한다. **Push는 사용자의 명시적 요청이 있을 때만** 수행한다. force-push to main/master 등은 거부하거나 강하게 경고한다.
- **후속:** commit/push 자동화 경계 문서·가드 정렬 → `needs-code` (NC-32).
- **상태:** `decided`

---

## Round 7 — 플랫폼 · 버전 · 텔레메트리 · 테스트 · 루프

### U1. 지원 플랫폼

- **모순·모호:** Menu Bar/Center macOS 중심 vs 다플랫폼 CLI.
- **증거:** native Menu Bar; CLI package.
- **Q→결정:** (a) macOS 완전 지원, Linux/Windows CLI best-effort? → **(a).**
- **확정 계약:** **macOS = 완전 지원**(CLI + Menu Bar/Center UI). **Linux/Windows = CLI만 best-effort**이며 UI 완전 지원을 제품 약속으로 두지 않는다.
- **후속:** README/지원 매트릭스 문구 정렬 → `needs-code` (NC-33).
- **상태:** `decided`

### U2. SKS 자체 버전(semver)

- **모순·모호:** 엄격 semver 강제 vs 마케팅 버전.
- **증거:** package.json version; release notes.
- **Q→결정:** (b) 마케팅 버전만, 엄격 semver 안 씀? → **(b).**
- **확정 계약:** SKS 제품 버전은 **마케팅/릴리즈 식별자**이다. breaking=major 등 **엄격 semver를 제품 계약·게이트로 강제하지 않는다.**
- **후속:** semver를 약속처럼 읽는 문서 완화 → `needs-code` (NC-34).
- **상태:** `decided`

### U3. 업데이트 채널

- **모순·모호:** `@latest` 외 pre-release 채널.
- **증거:** S4 npm `@latest` SSOT.
- **Q→결정:** (a) `@latest`만 제품 채널? → **(a).**
- **확정 계약:** 제품 업데이트 채널은 **`sneakoscope@latest`만**이다. `next`/beta 등은 **비제품**이며 설치 SSOT·릴리즈 완료의 대상이 아니다.
- **후속:** 채널 문서/Menu Bar induce를 `@latest`만으로 제한 → `needs-code` (NC-35).
- **상태:** `decided`

### U4. 텔레메트리 / 사용 분석

- **모순·모호:** 원격 수집 여부.
- **증거:** privacy expectations; T6 secrets.
- **Q→결정:** (a) 기본 off/없음? → **(a).**
- **확정 계약:** 원격 사용 분석·텔레메트리를 **수집하지 않는다**(기본 없음/off). opt-in 원격 분석 제품 경로도 두지 않는다.
- **후속:** 텔레메트리 암시 경로 제거·문서 명시 → `needs-code` (NC-36).
- **상태:** `decided`

### U5. 테스트 철학

- **모순·모호:** 커버리지 숫자 vs 선택적 검증.
- **증거:** Core Engineering Directive.
- **Q→결정:** (a) 주 경로 + 의미 있는 경계 + credible failure; 저가치 매트릭스 금지? → **(a).**
- **확정 계약:** 테스트는 **주 경로, 의미 있는 경계, credible failure**에 집중한다. 저가치 테스트 매트릭스 양산을 제품 계약으로 두지 않으며, 커버리지 숫자 목표는 제품 계약이 아니다.
- **후속:** 테스트/기여 가이드에 동일 철학 명시 → `needs-code` (NC-37).
- **상태:** `decided`

### U6. `$sks-loop` / 지속 루프

- **모순·모호:** SKS 루프 vs Codex native Goal 중복.
- **증거:** P3 Goal 단일 소유; `$sks-loop` skill.
- **Q→결정:** Codex가 이미 Goal을 제공하므로 **중복 기능 제거.**
- **확정 계약:** `$sks-loop` 및 SKS가 소유하는 **지속 루프/Goal-like 루프 기능은 제거**한다. Persisted goal/loop의 소유자는 Codex native Goal뿐이다(P3). SKS는 이에 평행하는 루프 제품을 유지하지 않는다.
- **후속:** loop 라우트·스킬·문서·등록 제거 또는 retired → `needs-code` (NC-38).
- **상태:** `decided`

### U7. Release proof bank

- **모순·모호:** 영구 보관 vs 레포 용량 vs 미션 삭제(S2).
- **증거:** release proof bank; S2 mission retention.
- **Q→결정:** 레포가 무거워지지 않는 선에서 **필수 정보만** 보관하고, 불필요해지면 **주기적으로 제거.**
- **확정 계약:** Release proof는 미션 파일과 별개로 둘 수 있으나, **필수 정보만** 남긴다. 레포 용량을 불필요하게 키우지 않으며, 더 이상 필요 없는 proof는 **주기적으로 제거**한다. “모든 역사적 proof 영구 보관”은 제품 계약이 아니다.
- **후속:** proof retention/prune 정책 구현·문서화 → `needs-code` (NC-39).
- **상태:** `decided`

---

## Round 8 — 브랜딩 · 설치 경로 · 리서치 · 접근성 · 오프라인 · 성능

### V1. 이름 SSOT

- **모순·모호:** sneakoscope / sks / Sneakoscope Codex 혼용.
- **증거:** package.json; CLI bin; README branding.
- **Q→결정:** (a) 제품명·CLI·npm 삼각형? → **(a).**
- **확정 계약:** **제품명** = Sneakoscope Codex; **CLI** = `sks`; **npm 패키지** = `sneakoscope`. 이 삼각형이 공식이다.
- **후속:** 대외/문서/UI 표기를 삼각형에 맞출 것 → `needs-code` (NC-40).
- **상태:** `decided`

### V2. Plugin marketplace 설치

- **모순·모호:** marketplace가 npm SSOT와 별개 권위인지.
- **증거:** S4 npm `@latest` SSOT; plugin marketplace path.
- **Q→결정:** (a) 편의 진입점, 결국 npm `@latest`와 동일, 불일치 fail? → **(a).**
- **확정 계약:** Plugin marketplace는 **편의 진입점**일 뿐이다. 설치 결과는 npm `sneakoscope@latest`와 **동일 버전**이어야 하며, 불일치는 **gate fail**이다. marketplace는 독립 설치 권위가 아니다.
- **후속:** marketplace/install 검증을 S4·C3에 연결 → `needs-code` (NC-41).
- **상태:** `decided`

### V3. `$sks-research`

- **모순·모호:** 핵심 trust-layer인지 부가인지.
- **증거:** T3/R4 내부·옵션 패턴.
- **Q→결정:** (a) 제품 계약 밖 내부/옵션? → **(a).**
- **확정 계약:** `$sks-research`는 **제품 핵심 계약 밖의 내부/옵션 라우트**이다. trust-layer 제품 완료와 동일시하지 않는다.
- **후속:** 라우트 표/README에서 핵심과 분리 → `needs-code` (NC-42).
- **상태:** `decided`

### V4. 접근성(a11y)

- **모순·모호:** UI a11y가 제품 요구인지 best-effort인지.
- **증거:** Menu Bar/Center UI; T4 CLI SSOT.
- **Q→결정:** (a) 제품 요구 — 합리적 a11y 회귀 방지? → **(a).**
- **확정 계약:** Menu Bar/Center UI의 **합리적 접근성**은 제품 요구이다. 알려진 a11y 회귀를 방치하지 않는다. (CLI SSOT와 별개로 UI 표면 요건.)
- **후속:** a11y 회귀 점검/문서 반영 → `needs-code` (NC-43).
- **상태:** `decided`

### V5. 오프라인 / 공기갭

- **모순·모호:** 오프라인 필수 지원 여부.
- **증거:** S4 npm `@latest`; Codex host dependency.
- **Q→결정:** (a) 오프라인은 필수 약속 아님? → **(a).**
- **확정 계약:** 오프라인/공기갭 동작은 **필수 제품 약속이 아니다.** 정상 경로는 온라인에서 npm `@latest`와 Codex 호스트를 쓰는 것이다.
- **후속:** 오프라인 완전 지원처럼 읽히는 문구 제거 → `needs-code` (NC-44).
- **상태:** `decided`

### V6. 성능 약속

- **모순·모호:** SLA/벤치 숫자가 제품 약속인지.
- **증거:** performance docs/evaluator.
- **Q→결정:** (a) 구체 SLA/벤치 숫자 약속 없음? → **(a).**
- **확정 계약:** 구체적 성능 SLA나 벤치 숫자 약속은 **제품 계약이 아니다.** 측정은 내부/옵션으로만 둔다.
- **후속:** 숫자를 약속처럼 읽는 대외 문구 정리 → `needs-code` (NC-45).
- **상태:** `decided`

### V7. Codex 호스트 업그레이드 책임

- **모순·모호:** SKS가 호스트까지 자동 업그레이드하는지.
- **증거:** C1 always-latest; R6 consume-only; S4.
- **Q→결정:** (a) SKS는 유도·검사·불일치 fail; 업그레이드 실행은 사용자/Codex? → **(a).**
- **확정 계약:** SKS는 Codex 호스트에 대해 **유도·능력 검사·불일치 시 fail**까지 수행한다. 호스트 Codex **업그레이드 실행 자체는 사용자 또는 Codex**의 책임이며, SKS가 호스트를 자동 업그레이드하는 것을 제품 경로로 두지 않는다.
- **후속:** update-check/문서의 책임 경계 명시 → `needs-code` (NC-46).
- **상태:** `decided`

---

## Round 9 — 스킬 권위 · 호스트 표면 · i18n · MCP · 제거 · 동시성

### W1. Managed skill 파일 권위

- **모순·모호:** project-local / cache / 옛 경로 vs 글로벌 managed skill.
- **증거:** AGENTS managed skill remap rules.
- **Q→결정:** (a) 절대 계약? → **(a).**
- **확정 계약:** 글로벌 managed skill이 project-local·cache·옛 경로보다 **우선**한다. Remap 성공 후 **현재 파일만** 읽고, stale 경로 mismatch를 사용자에게 **보고하지 않는다.**
- **후속:** 스킬/훅 문구와 구현이 절대 계약과 일치하는지 확인 → `needs-code` (NC-47).
- **상태:** `decided`

### W2. Codex CLI vs ChatGPT Desktop

- **모순·모호:** 어느 호스트가 1급인지.
- **증거:** P1 제품 문장.
- **Q→결정:** (a) 둘 다 동등 1급? → **(a).**
- **확정 계약:** **Codex CLI와 ChatGPT Desktop은 동등한 1급 호스트**이다. 한쪽만 공식으로 두지 않는다.
- **후속:** 지원/문서에서 동등 1급 표기 → `needs-code` (NC-48).
- **상태:** `decided`

### W3. Cursor / 기타 에디터

- **모순·모호:** Cursor 등에서 SKS를 쓸 때의 제품 약속.
- **증거:** W2; 개발 중 Cursor 사용 현실.
- **Q→결정:** (a) 공식 호스트 아님? → **(a).**
- **확정 계약:** Cursor 및 기타 에디터는 **공식 호스트가 아니다.** 공식은 Codex CLI / ChatGPT Desktop뿐이다. 다른 환경은 best-effort이며 제품 약속이 아니다.
- **후속:** 지원 범위 문서에 비공식 명시 → `needs-code` (NC-49).
- **상태:** `decided`

### W4. UI/문서 언어(i18n)

- **모순·모호:** 한/영 동등 vs 영어 SSOT.
- **증거:** README/UI copy; 한국어 내부 문서 혼재.
- **Q→결정:** (a) 영어가 제품 SSOT? → **(a).**
- **확정 계약:** 제품 UI·대외 문서의 언어 SSOT는 **영어**이다. 다른 언어는 best-effort이며 동등 공식 i18n을 약속하지 않는다. (이 원장처럼 내부 결정 기록은 예외로 다른 언어를 쓸 수 있다.)
- **후속:** 대외 표면 영어 SSOT 정렬 → `needs-code` (NC-50).
- **상태:** `decided`

### W5. 타사 MCP 서버

- **모순·모호:** SKS가 MCP를 보증·allowlist 하는지.
- **증거:** S7 Context7 정책; host MCP config.
- **Q→결정:** (a) 사용자/호스트 영역, SKS 비보증? → **(a).**
- **확정 계약:** 사용자가 붙이는 타사 MCP는 **호스트/사용자 영역**이다. SKS는 이를 기본 포함하거나 동작·보안을 **보증하지 않는다.** (스택 문서용 Context7 등 S7 정책과 별개: 문서 우선 규칙은 유지, MCP 자체를 SKS 제품 표면으로 두지 않음.)
- **후속:** MCP 비보증 문구 문서화 → `needs-code` (NC-51).
- **상태:** `decided`

### W6. 제거(uninstall)

- **모순·모호:** npm uninstall 잔여 vs 완전 제거.
- **증거:** install/doctor harness paths; R7.
- **Q→결정:** `sks uninstall`로 SKS 관련 셋업·파일을 **완벽하게** 제거.
- **확정 계약:** 제품 제거 경로는 **`sks uninstall`**이다. 실행 시 SKS 관련 셋업 및 파일은 **완벽하게 제거**되어야 한다. `npm uninstall`만으로 잔여 harness가 남는 상태를 정상으로 두지 않는다.
- **후속:** `sks uninstall` 완전 제거 구현·검증 → `needs-code` (NC-52).
- **상태:** `decided`

### W7. 동시 다수 SKS 인스턴스

- **모순·모호:** 동시 실행 지원 vs 금지.
- **증거:** mission/evidence writers; Menu Bar + CLI.
- **Q→결정:** (b) best-effort 허용? → **(b).**
- **확정 계약:** 같은 머신/레포에서 여러 `sks`가 동시에 도는 것은 **best-effort**이다. 완전한 직렬화·락·동시성 안전은 **제품 약속이 아니다.**
- **후속:** “동시성 보장”처럼 읽히는 문구 제거 → `needs-code` (NC-53).
- **상태:** `decided`

---

## Round 10 — 라이선스 · 멀티에이전트 · 리뷰 라우트 · 로그 · 지원 · align 한도

### X1. 오픈소스 / 기여

- **모순·모호:** 외부 기여 수용 여부.
- **증거:** public repo norms.
- **Q→결정:** (a) 공개 + 외부 기여 welcome? → **(a).**
- **확정 계약:** 공개 레포이며 외부 기여는 **welcome**한다. 표준 PR/이슈 경로를 공식 기여 경로로 둔다.
- **후속:** CONTRIBUTING/README에 welcome 명시 → `needs-code` (NC-54).
- **상태:** `decided`

### X2. Naruto multi-agent V2

- **모순·모호:** opt-in vs 필수; SKS 자체 구현 vs 호스트 wrap.
- **증거:** README multi-agent V2; R6 consume-only.
- **Q→결정:** (b) V2 없으면 제품 미완성 + **Codex 공식 multi-agent를 랩핑하는 방식으로만 존재.**
- **확정 계약:**
  1. 호스트가 공식 multi-agent를 제공하지 않으면 제품은 **미완성**으로 본다.
  2. SKS multi-agent/Naruto 병렬은 **Codex가 공식적으로 제공하는 multi-agent 시스템을 랩핑(consume/bridge)** 하는 방식으로만 존재한다. SKS 독자 multi-agent 런타임 재구현은 금지한다(R6와 동일 계열).
- **후속:** wrap-only 경로로 정렬; 평행 구현 제거 → `needs-code` (NC-55).
- **상태:** `decided`

### X3. `$sks-review` / security / bugbot

- **모순·모호:** 내부 옵션 vs 릴리즈 필수; 언제 돌릴지.
- **증거:** review skills; T1 Honest Mode 리듬; R2 release gates.
- **Q→결정:** (b) 릴리즈 필수 핵심 + **작업 충분히 끝난 말미에 1회, 미비점만 재갱신 루프.**
- **확정 계약:** review / security / bugbot 류는 **릴리즈 필수 핵심**이다. 실행 리듬은 T1과 같다 — 가능한 작업을 충분히 수행한 뒤 **제일 마지막 즈음에 한 번씩** 돌리고, 미비점만 다시 갱신하는 루프로 불필요한 시간 연장을 막는다.
- **후속:** 릴리즈 게이트/문서에 말미 리뷰 루프 반영 → `needs-code` (NC-56).
- **상태:** `decided`

### X4. 로그·디버그 출력

- **모순·모호:** 기본 상세 로그 vs 최소.
- **증거:** CLI/Menu Bar output.
- **Q→결정:** (a) 기본 최소; verbose는 명시 플래그? → **(a).**
- **확정 계약:** 기본 출력은 사용자에 필요한 **최소**이다. verbose/debug는 **명시적 플래그**로만 켠다.
- **후속:** 기본 로그 수준 정렬 → `needs-code` (NC-57).
- **상태:** `decided`

### X5. 사용자 지원 채널

- **모순·모호:** 공식 지원 창구.
- **증거:** GitHub repo.
- **Q→결정:** (a) GitHub Issues가 공식? → **(a).**
- **확정 계약:** 공식 사용자 지원 채널은 **GitHub Issues**이다.
- **후속:** README 지원 링크 고정 → `needs-code` (NC-58).
- **상태:** `decided`

### X6. Align 한도(대형 레포)

- **모순·모호:** fail-closed vs 부분 성공.
- **증거:** TriWiki align handoff caps.
- **Q→결정:** (a) fail-closed 유지? → **(a).**
- **확정 계약:** binary / oversized / cap 도달 시 align은 **조용히 건너뛰지 않고 fail-closed**한다. 구체 한도 숫자는 구현 상세이며, 부분 인덱스를 성공으로 위장하지 않는다.
- **후속:** fail-closed 테스트/문서 유지 → `needs-code` (NC-59).
- **상태:** `decided`

### X7. 이 원장의 지위

- **모순·모호:** 참고 메모 vs 계약 SSOT.
- **증거:** `docs/AMBIGUITY-RESOLUTIONS.md`; PROC-*.
- **Q→결정:** (a) 제품 계약 SSOT 중 하나; 인터뷰 Round 10 종료? → **(a).**
- **확정 계약:** 이 문서는 **제품 계약 SSOT 중 하나**이다. 코드/문서와 충돌하면 **이 결정에 맞춘다.** 모호점 인터뷰는 **Round 10에서 종료**한다. 이후 변경은 명시적 추가/개정으로만 한다(PROC-5).
- **후속:** NC 백로그 구현 시 이 원장을 기준으로 정렬 → `needs-code` (NC-60).
- **상태:** `decided`

---

## 인터뷰 종료

Round 1–10 완료. 추가 인터뷰 Round는 열지 않는다.  
다음 단계는 `needs-code` 백로그(**NC-1–NC-60**) 구현이다.
