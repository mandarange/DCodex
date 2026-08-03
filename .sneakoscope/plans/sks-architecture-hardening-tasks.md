# SKS Architecture Hardening — Parallel Tasks

> Plan artifact only. `implementation_allowed=false`
>
> 기준일: 2026-08-02  
> 실행 전환: 사용자가 명시적으로 구현을 재개한 뒤 `$sks-work`로 수행  
> 현재 문서의 유일한 편집자: 루트 코디네이터

## 목표

Codex Desktop이 보는 transport identity는 항상 native `openai`로 유지하면서, 로컬 loopback proxy 내부에서 ChatGPT OAuth, Codex LB, OpenRouter를 독립·배타적으로 강제한다. 이 기반 위에 세션 고정, 하위 에이전트 정책, Keychain·메뉴바 안정성, 최신 카탈로그·기능 호환 상태, 증거/그래프 무결성, 이미지 reference-only 정책, 진행 신호 기반 일시정지·재개, SKS 명령 정규화와 그래프 게이트를 구현하고 격리 환경에서 검증한다.

## 범위와 비범위

포함:

- native OpenAI loopback transport와 proxy-side provider policy enforcement
- 세션/포크/재개/하위 에이전트의 mode·model·policy snapshot 고정
- Keychain, 메뉴바, SKS Center의 무인 재시작·오류 복구·명시적 재연결
- native Codex 카탈로그 동기화와 기능별 직접 처리/OAuth 보조 호환 상태
- FAST/HEAVY/ULTRA `IntentContract`, terminal state, 증거 게이트, 재계획 판정
- 프로젝트 격리 `EvidenceKey v2`, 관련 receipt 무효화, graph write lock·atomic replace
- 이미지 path/URI + SHA-256 + metadata만 보관하는 references-only evidence
- 진행 신호 기반 pause/resume와 비가역 관찰 상태
- 모든 SKS alias/명령의 `IntentContract` 정규화와 legacy migration
- hermetic API/contract E2E와 별도의 macOS signed-app UI QA

비범위:

- 외부 계정 설정 변경, 키 회전, 사용량 한도 변경, 배포·릴리스
- 사용자 `~/.codex`, 사용자 Codex 계정, 사용자 Keychain의 테스트 사용 또는 변경
- 실제 키가 안전한 프로세스 환경에 명시 주입되지 않은 상태에서의 실연동 대체
- OpenCodex 코드 복사
- 자동 recapture, 이미지 원본 mission 복사, 명시 동의 없는 외부 이미지 전송
- 시간 경과만을 근거로 한 작업 종료

## 실행 불변식

1. 외부 transport identity는 built-in `openai`; 실제 upstream source는 UI/metadata에 투명하게 표시한다.
2. 세 모드는 독립·배타적이다. proxy가 mode·credential class·model allowlist·child policy snapshot을 최종 강제하며 조용한 교차 fallback을 금지한다.
3. 설정은 `draft`와 `last_known_good`를 분리하고, 저장 → proxy 반영 → catalog 갱신 → 새 세션 사용 가능의 네 단계를 실제 결과로 표시한다.
4. 세션은 생성 시 snapshot을 고정한다. 전역 기본 변경은 기존 세션을 바꾸지 않으며, 복원 조건 불일치는 자동 전환 대신 재개 불가 사유가 된다.
5. OAuth 보조 경로는 proxy가 지원하지 않는 특정 native 기능 요청에만, 사전 사용자 허용과 명시적 상태·감사 이벤트를 전제로 사용한다. 세션 mode는 바뀌지 않는다.
6. 비밀, 계정 식별자, 요청 본문, credential fingerprint는 저장·표시·로그하지 않는다. 감사에는 mode, model, OAuth 보조 여부, 고정된 실패 원인만 남긴다.
7. Keychain은 안정적 service/account/환경 영역을 사용하며 일반 실행·재시작은 non-interactive다. 자동 인증 UI는 금지하고 사용자가 `재연결`을 누른 경우에만 상호작용을 허용한다.
8. read-only는 source와 사용자 설정을 불변으로 유지하며 프로젝트 격리 관찰 로그만 쓸 수 있다.
9. FAST는 만료 증거를 표시하고 직접 대상 증거만 갱신한다. HEAVY는 관련 유효 증거가 필요하다. 일반 변경은 검증 미완료(`unverified`)로 진행할 수 있지만 실제 auth/security/delete/deploy/dependency 변경은 증거 부족 시 차단한다.
10. `force`는 게이트를 우회하거나 실제 HEAVY를 FAST로 낮출 수 없다. 진단 범위 또는 허용된 재시도 범위만 넓힌다.
11. graph write는 프로젝트별 단일 writer lock 아래 staging → 구조/참조 검증 → atomic replace로 수행한다. reader는 병렬 허용하며 두 번째 writer는 대기한다.
12. 참조 byte가 missing/changed이면 `expired_reference`; 자동 재캡처·외부 전송·cache HIT/PASS는 금지한다.
13. 시간 예산은 경고·진단 기준이다. 동일 원인의 일시적 network 실패만 최대 2회 자동 재개하고 auth/mode/account/external-config는 사용자 확인 전까지 `paused`다.
14. 결과는 `구현`, `계약 테스트`, `격리 실환경 검증`을 서로 다른 상태로 기록한다.

## 현재 상태표

이 표는 현재 작업 트리 관찰값이며 배포·릴리스 상태가 아니다. `계약 테스트`는 mock/static/unit evidence만 뜻하며 실제 Codex Desktop이나 외부 서비스 실행을 증명하지 않는다.

| 영역 | 정책 | 현재 소스 상태 | 계약 테스트 상태 | 격리 실환경 상태 | 남은 핵심 |
|---|---|---|---|---|---|
| native OpenAI + loopback | 확정 | 구현: built-in `openai` identity, loopback-only transport, inbound auth stripping, HTTP/WS metadata 보존 | transport/router/integration 계약 테스트 통과 | hermetic mock 통과; 실제 Codex Desktop 미검증 | 실제 설치의 native catalog/UI 보존 확인 |
| 배타적 provider routing | 확정 | 구현: mode·credential class·model family·no-fallback을 proxy choke point에서 강제 | mode/key/model/no-failover matrix 통과 | hermetic mock 통과; live LB/OR 미검증 | 승인된 실 credential 주입 후 live 확인 |
| 세션·포크·재개 고정 | 확정 | 구현: immutable pin과 restore/fork/resume 정책, 명시 header 검증 연결 | lifecycle/mismatch 계약 테스트 통과 | hermetic mock 통과; 실제 Desktop lifecycle 미검증 | upstream이 sealed session headers를 제공하기 전 `require_session_pin` 기본값은 호환 모드 |
| 하위 에이전트 정책 | 확정 | 구현: OAuth/LB/OpenRouter 별 child ownership과 parent snapshot 검증 | child/account/model 경계 테스트 통과 | hermetic mock 통과; 실제 Desktop child protocol 미검증 | upstream sealed child headers 실연동 |
| Keychain | 확정 | 구현: dev/prod namespace, non-interactive read, 상태 구분, explicit reconnect만 상호작용 | Swift compile/harness 및 정책 테스트 통과 | `not_verified: signed_app_required` | production 서명 앱·접근 그룹으로 반복 재시작 QA |
| 메뉴바/SKS Center | 확정 | 구현: action/loading/result/recovery, 4단계 apply, 최소 복구 UI 연결 | 30개 템플릿/컴파일 및 신뢰성 테스트 통과 | signed UI fixture 통과; 실제 signed 앱 미검증 | production-signed UI 실행 |
| catalog/기능 호환 | 확정 | 구현: startup/apply/manual/background refresh, last-good·changed·failure·OAuth auxiliary projection | catalog/withdrawal/background failure 테스트 통과 | hermetic mock 통과; live catalog 미검증 | 실제 공급자 catalog 변동 확인 |
| progress pause/resume | 확정 | 구현: progress signal, warning-only budget, 2회 network retry, manual resume token과 Center projection | reducer/Swift recovery 테스트 통과 | hermetic offline/restart/pause/resume 통과 | 실제 장기 작업의 각 progress source 운영 검증 |
| IntentContract | 확정 | 구현: effect 우선 risk, immutable hash/replay, evidence gate, terminal state | adversarial/replay/replan 테스트 통과 | 해당 없음 | 없음 |
| EvidenceKey v2/project isolation | 확정 | 구현: 비가역 project ID, target/dependency Merkle, 영향 receipt 선택 | isolation/HIT/MISS/invalidation 테스트 통과 | hermetic graph gate 통과 | 없음 |
| graph atomicity/lock | 확정 | 구현: project writer lock, staging validation, atomic replace, provenance conflict | reader/writer/crash/conflict/cache 테스트 통과 | hermetic graph gate 통과 | 없음 |
| image references-only | 확정 | 구현: path/URI+SHA-256+metadata, explicit revalidate/one-shot transfer permit; 기본 copy/upload 제거 | changed/missing/symlink/no-copy/no-network 테스트 통과 | hermetic integration 통과 | 명시 동의가 있는 실제 외부 전송은 별도 검증 |
| command normalization/legacy | 확정 | 구현: 전체 alias canonicalization, effect contract 우선, deprecation과 inspect/plan/apply migration | alias/hash/force/migration/rollback 테스트 통과 | 해당 없음 | 없음 |
| sandbox E2E | 확정 | 구현: temp HOME/CODEX_HOME/SKS_HOME, mock LB/OR/OAuth/catalog, secret-safe report | hermetic E2E와 filesystem isolation 통과 | mock verified; live `not_verified: secret_injection_required` | 승인된 정확한 LB key/base URL 주입 |

## 병렬 실행 규칙

- 작업자는 이 Tasks 파일을 수정하지 않는다. 체크박스와 상태표는 wave 사이에 루트 코디네이터 한 명만 갱신한다.
- 각 작업의 `소유 범위` 밖 파일은 읽기만 허용한다. barrel export, `package.json`, 공용 fixture, 공용 snapshot을 편의상 수정하지 않는다.
- 계약 작업 `AH-000`과 상태 SSOT `AH-001`을 먼저 merge한다. 후속 작업은 해당 commit hash를 base로 사용하고 계약을 복사하지 않는다.
- 같은 wave의 소유 범위는 서로 겹치지 않는다. 통합 choke point는 `AH-300` 한 명만 소유한다.
- 한 파일의 소유권을 넘겨야 하면 기존 소유 작업이 merge되고 handoff가 승인된 뒤에만 다음 작업을 시작한다. 동시 편집은 금지한다.
- 테스트는 각 작업의 소유 디렉터리 안에 둔다. 공용 runner/script 수정이 필요하면 구현하지 말고 `AH-300` handoff에 요구사항만 기록한다.
- 독립 worktree를 사용할 때도 동일한 base commit과 contract version을 기록한다. contract, policy version, mode snapshot 또는 target hash가 다르면 merge 대신 replan한다.
- 실제 credential은 fixture, 파일, 로그, 테스트 이름, screenshot에 넣지 않는다. E2E는 승인된 정확한 env 이름의 존재 여부만 boolean으로 확인하며 값을 출력하지 않는다.

## 공통 handoff contract

각 하위 에이전트는 최종 메시지에 아래 항목을 같은 순서로 반환한다. 별도 공유 handoff 파일은 만들지 않는다.

```text
task_id:
base_commit:
contract_version:
owned_paths_changed:
public_interfaces_added_or_changed:
acceptance_checks:
tests_run_and_results:
implementation_status: implemented | partial | blocked
contract_test_status: passed | failed | not_run
real_environment_status: verified | not_verified | blocked
blockers_and_replan_triggers:
secret_or_user_config_access: none
```

Handoff 승인 조건:

- `owned_paths_changed`가 해당 task의 소유 범위 부분집합이다.
- 실패·미실행·실환경 미검증을 성공으로 합치지 않는다.
- mode/model/account/evidence snapshot이 필요한 API는 opaque ID 또는 enum만 노출하고 비밀/계정 ID/본문을 받거나 반환하지 않는다.
- contract test는 mock 증거임을 명시한다.
- downstream task가 필요한 interface와 고정 error code를 기록한다.

## Wave 0 — 계약과 단일 진실 원천

- [x] **AH-000 — 공통 아키텍처 계약을 봉인한다**
  - 소유 범위: `src/core/architecture-hardening/contracts/**`
  - 선행 조건: 없음
  - 병렬 가능 여부: 첫 작업으로 단독 수행; merge 후 Wave 1 전체 병렬 가능
  - 구현:
    - `ProviderMode`, `CredentialReadiness`, `ProviderPolicySnapshot`, `SessionPin`, `ChildPolicySnapshot`, `CatalogSnapshot`, `FeatureCompatibility`, `ApplyStageReceipt`, `RecoveryState`, `IntentContractRef`, `EvidenceKeyRef`의 versioned 타입과 runtime validator를 정의한다.
    - user-facing reason/action은 고정 error/recovery code로만 전달하고 내부 진단은 비가역 ID만 허용한다.
    - audit projection에서 key/account/body/fingerprint 필드를 schema 수준에서 금지한다.
  - 수용 기준:
    - 세 mode가 exhaustive하고 상호 배타적이다.
    - mode/model/credential/child snapshot 불일치가 명시적 error code로 거부된다.
    - 계약 객체가 JSON round-trip 후에도 동일하고 unknown field 처리 정책이 고정된다.
  - 테스트: `node --test`로 schema round-trip, cross-mode rejection, prohibited-field rejection, stable reason code를 검증한다.
  - Handoff: contract version과 downstream direct-import 경로를 고정한다.

- [x] **AH-001 — draft/last-known-good 로컬 상태 서비스를 만든다**
  - 소유 범위: `src/core/architecture-hardening/state/**`
  - 선행 조건: AH-000
  - 병렬 가능 여부: AH-000 이후 단독 merge; Wave 1의 모든 reader가 병렬 소비
  - 구현:
    - proxy/local state service를 mode, credential readiness, catalog, feature compatibility, session pin, apply receipt의 단일 진실 원천으로 만든다.
    - draft와 last-known-good를 분리하고 validate → stage → atomic commit 또는 rollback을 제공한다.
    - 저장 실패나 불완전 apply는 last-known-good를 훼손하지 않는다.
  - 수용 기준:
    - 네 단계 receipt가 각각 pending/running/succeeded/failed와 고정 원인을 가진다.
    - existing session과 new-session default가 별도 projection이다.
    - crash injection 후 last-known-good가 byte-identical하게 유지된다.
  - 테스트: temp root에서 atomic commit, stage failure, crash recovery, concurrent readers, redaction snapshot을 검증한다.
  - Handoff: read/write port와 transaction boundary만 공개하고 UI/backend 구현 세부는 노출하지 않는다.

## Wave 1 — 독립 도메인 구현

- [x] **AH-101 — native OpenAI loopback transport 계약을 구현한다**
  - 소유 범위: `src/core/codex-lb/native-openai-transport/**`
  - 선행 조건: AH-000, AH-001
  - 병렬 가능 여부: AH-102~AH-114와 병렬
  - 구현: built-in `openai` identity, loopback-only URL, inbound header stripping, upstream credential replacement, request/response metadata preservation, HTTP/WS feature passthrough contract를 캡슐화한다.
  - 수용 기준: 외부 provider identity 주입을 거부하고 Codex native metadata를 삭제하지 않으며 사용자 OAuth bearer가 LB/OR upstream으로 전달되지 않는다.
  - 테스트: HTTP/WS fixtures, header leakage negative test, non-loopback rejection, catalog/feature metadata byte-equivalence.
  - Handoff: transport adapter interface와 forbidden header set.

- [x] **AH-102 — proxy-side 배타적 provider router를 구현한다**
  - 소유 범위: `src/core/codex-lb/provider-routing/**`
  - 선행 조건: AH-000, AH-001
  - 병렬 가능 여부: Wave 1 병렬
  - 구현: ChatGPT OAuth/Codex LB/OpenRouter mode별 credential class, model allowlist, source metadata와 no-fallback 정책을 강제한다.
  - 수용 기준: key 미등록/만료/검증 실패 시 model/child catalog가 빈 목록이고, cross-mode request와 silent failover가 모두 거부된다.
  - 테스트: mode × key state × model family matrix, LB quota/5xx no-account-failover, OR request가 LB key를 읽지 않는 negative test.
  - Handoff: routing decision API와 stable rejection codes.

- [x] **AH-103 — 세션/포크/재개 pinning을 구현한다**
  - 소유 범위: `src/core/codex-app/session-policy/**`
  - 선행 조건: AH-000, AH-001
  - 병렬 가능 여부: Wave 1 병렬
  - 구현: mode, model, allowed models, credential class, LB affinity token, child policy hash, catalog version을 생성 시 고정한다.
  - 수용 기준: 전역 mode 변경이 기존 pin을 바꾸지 않고, fork/resume가 snapshot을 상속하며 legacy/missing metadata는 명시적 migration_required다.
  - 테스트: create/fork/resume/global-switch/restore-mismatch/account-failure property matrix.
  - Handoff: immutable session envelope와 replan/resume blocker codes.

- [x] **AH-104 — mode별 하위 에이전트 정책을 구현한다**
  - 소유 범위: `src/core/codex-app/child-policy/**`
  - 선행 조건: AH-000, AH-103의 interface handoff
  - 병렬 가능 여부: AH-103 interface가 봉인된 뒤 AH-105~AH-114와 병렬
  - 구현: LB dynamic child selection, SKS Center 등록 OpenRouter child 목록, OAuth native allocation ownership을 서로 분리한다.
  - 수용 기준: child request가 parent snapshot을 포함하고 proxy mismatch 시 거부되며, OAuth mode에는 SKS override 목록을 주입하지 않는다.
  - 테스트: parent/child/fork snapshot inheritance, unregistered OR model rejection, LB family/account-boundary rejection, OAuth passthrough.
  - Handoff: child snapshot hash와 provider-owned selection API.

- [x] **AH-105 — 카탈로그 동기화와 기능 호환 상태를 구현한다**
  - 소유 범위: `src/core/codex-app/catalog-compat/**`
  - 선행 조건: AH-000, AH-001
  - 병렬 가능 여부: Wave 1 병렬
  - 구현:
    - 시작·설정 적용·수동 확인·낮은 주기 background에서 native catalog를 읽고 mode/key 검증 결과로 필터링한다.
    - last-good catalog, changed flag, last checked, failure reason, cache invalidation/restart requirement를 기록한다.
    - 기능별 direct proxy/OAuth auxiliary/unavailable와 OAuth 필요 여부를 계산한다.
  - 수용 기준: 실패 시 검증된 이전 catalog만 유지하고 새 미검증 model은 노출하지 않으며 기존 session pin은 바뀌지 않는다.
  - 테스트: catalog changed/unchanged/failure/restart, key revocation withdrawal, OAuth absent/allowed/success/failure/direct-support-restored.
  - Handoff: catalog/feature status projection과 refresh trigger API.

- [x] **AH-106 — 안정적·비대화형 Keychain 계층을 완성한다**
  - 소유 범위: `native/sks-menubar/Sources/SKSKeychainStore.swift`, `native/sks-menubar/Tests/SKSKeychainStoreTests.swift`
  - 선행 조건: AH-000
  - 병렬 가능 여부: Wave 1 병렬; 다른 작업은 이 두 파일 편집 금지
  - 구현: dev/prod service namespace, logical account, access-group/signing 상태, duplicate/legacy migration, not-found/locked/access-denied/signing-mismatch/damaged 구분을 고정한다.
  - 수용 기준: normal read/restart/background refresh는 interaction-not-allowed이며 사용자 reconnect action만 interactive write/auth를 시작한다. OAuth refresh token 소유권은 공식 Codex 경로를 침범하지 않는다.
  - 테스트: injectable Security abstraction으로 first approval, repeated restart, deleted item, locked chain, duplicate migration, signing mismatch, no-secret logs를 검증한다.
  - Handoff: credential readiness enum과 explicit reconnect closure.

- [x] **AH-107 — 진행 신호 기반 pause/resume 코어를 구현한다**
  - 소유 범위: `src/core/runtime/progress-recovery/**`
  - 선행 조건: AH-000, AH-001
  - 병렬 가능 여부: Wave 1 병렬
  - 구현: evidence/file/test/model/tool progress signal, warning-only time budget, cause classifier, bounded network retry, resumable pause와 manual resume token을 정의한다.
  - 수용 기준: 실제 진행 중에는 시간으로 종료하지 않고 동일 network cause만 최대 2회 재개한다. auth/mode/account/external-config/unknown 및 재시도 소진은 상태를 보존한 채 paused다.
  - 테스트: fake clock, progress/no-progress, cause transitions, retry ceiling, integrity snapshot preservation, manual resume confirmation.
  - Handoff: reducer, retry-safe executor port, Center-safe projection.

- [x] **AH-108 — immutable FAST/HEAVY IntentContract를 구현한다**
  - 소유 범위: `src/core/safety/intent-contract/**`
  - 선행 조건: AH-000
  - 병렬 가능 여부: Wave 1 병렬
  - 구현:
    - prompt effect, observed changed paths, canonical command, target hashes, policy version, mode snapshot, evidence state, retry budget을 stable-hash 계약으로 만든다.
    - FAST 기본, 실제 auth/security/delete/deploy/dependency effect만 HEAVY, ULTRA는 explicit opt-in으로 제한한다.
    - `failed|paused|unverified|completed` terminal state와 reuse/replan 판정을 정의한다.
  - 수용 기준: 위험 명사만 있는 read-only 설명은 FAST이고 실제 위험 effect는 명시 light command보다 우선한다. 사용자 override는 HEAVY 상향만 가능하며 force는 우회하지 못한다.
  - 테스트: adversarial phrase/effect matrix, object immutability, stable hash/replay, target/policy/mode mismatch replan, FAST expired evidence, HEAVY evidence-required.
  - Handoff: contract builder, risk rationale, replay decision API.

- [x] **AH-109 — project-isolated EvidenceKey v2를 구현한다**
  - 소유 범위: `src/core/evidence/v2/**`
  - 선행 조건: AH-000
  - 병렬 가능 여부: Wave 1 병렬
  - 구현: irreversible project ID, criterion/check, direct target hashes, direct dependency Merkle, auth mode, model policy, validator rule/version, env/toolchain을 키에 포함한다.
  - 수용 기준: clone은 새 project ID이고 경로명·계정 ID·비밀은 키/로그에 없다. 승인된 변경 요인이 영향을 주는 receipt만 invalidation된다.
  - 테스트: clone isolation, unrelated-change HIT, direct dependency MISS, auth/model/rule invalidation, secret redaction, deterministic key.
  - Handoff: EvidenceKey builder와 affected-receipt selector.

- [x] **AH-110 — graph writer lock과 staging atomicity를 강화한다**
  - 소유 범위: `src/core/triwiki/context-graph/store/compile-lock.ts`, `src/core/triwiki/context-graph/store/fragment-cache.ts`, `src/core/triwiki/context-graph/store/snapshot-store.ts`, `src/core/triwiki/context-graph/store/evidence-write-lock.ts`, `src/core/triwiki/context-graph/store/__tests__/architecture-hardening-store.test.ts`
  - 선행 조건: AH-000, AH-109 interface handoff
  - 병렬 가능 여부: AH-109 interface 봉인 뒤 Wave 1 병렬; 다른 작업은 이 파일들 편집 금지
  - 구현: project-scoped evidence writer lock, bounded wait, staging snapshot validation, atomic replace, user provenance conflict, fragment reuse를 결합한다.
  - 수용 기준: reader 병렬, writer 1개, 두 번째 writer 대기, invalid staging은 current를 바꾸지 않음, user edit는 conflict이며 자동 overwrite되지 않음.
  - 테스트: concurrent readers/writers, crash before replace, invalid reference, stale lock recovery, provenance conflict, fragment HIT/MISS reason.
  - Handoff: lock lifecycle와 atomic commit receipt.

- [x] **AH-111 — image evidence를 references-only로 전환한다**
  - 소유 범위: `src/core/image/reference-evidence/**`, `src/core/image-ux-review/reference-policy/**`
  - 선행 조건: AH-000, AH-109 interface handoff
  - 병렬 가능 여부: Wave 1 병렬
  - 구현: path/URI, SHA-256, size/type/mtime metadata, consent state만 등록하고 explicit revalidate와 explicit external-transfer permit를 분리한다.
  - 수용 기준: missing/changed는 `expired_reference`; 자동 recapture/copy/upload가 없고 expired reference는 HIT/PASS가 될 수 없다.
  - 테스트: unchanged/changed/missing/symlink/out-of-root, no-copy filesystem assertion, no-network default, explicit transfer one-shot permit.
  - Handoff: reference registry/validator/consent API. 기존 `stageImage` 호출 교체 요구는 AH-300에 전달한다.

- [x] **AH-112 — SKS command/alias 정규화 계약을 구현한다**
  - 소유 범위: `src/core/commands/intent-normalization/**`
  - 선행 조건: AH-108 interface handoff
  - 병렬 가능 여부: AH-108 interface 봉인 뒤 Wave 1 병렬
  - 구현: 모든 `$sks*` alias와 CLI form을 canonical command + natural-language effect + immutable execution contract로 정규화하고 deprecation descriptor를 만든다.
  - 수용 기준: alias별 결과가 동일 contract hash를 만들며 자연어 실제 effect가 명시 command의 낮은 risk 표기보다 우선한다. 보장 불가 legacy option은 조용히 수용하지 않는다.
  - 테스트: full manifest alias table, conflicting explicit command/effect, force, read-only, deprecated option warning/error, replay reuse.
  - Handoff: normalizer와 legacy mapping table.

- [x] **AH-113 — legacy provider/command migration을 구현한다**
  - 소유 범위: `src/core/architecture-hardening/migration/**`
  - 선행 조건: AH-000, AH-102, AH-112 interface handoff
  - 병렬 가능 여부: 관련 interface 봉인 뒤 AH-114와 병렬
  - 구현: custom external provider injection, mixed provider catalog, missing session metadata, obsolete aliases/options를 inspect → plan → explicit apply 단계로 마이그레이션한다.
  - 수용 기준: 참조 확인 전 삭제하지 않고 user edits/provenance를 보존한다. ambiguity는 migration_required이며 자동 추론하지 않는다.
  - 테스트: no-op current config, each legacy fixture, user-edit conflict, rollback, idempotency, secret-free receipt.
  - Handoff: migration plan/apply API와 removable-path proof 목록.

- [x] **AH-114 — 관찰성 projection을 구현한다**
  - 소유 범위: `src/core/observability/architecture-hardening/**`
  - 선행 조건: AH-000, AH-001, AH-107 interface handoff
  - 병렬 가능 여부: interface 봉인 뒤 Wave 1 병렬
  - 구현: verification time, critical path, HIT/MISS/BYPASS/EXPIRED + reason, retry count, FAST/HEAVY reason, progress signal, pause cause, recovery attempt, next action을 안전한 projection으로 만든다.
  - 수용 기준: key/account/body/fingerprint가 어떤 serializer/log에서도 나오지 않고 UI에는 고정 원인·복구 행동만 보인다.
  - 테스트: golden redaction snapshots, status transition matrix, malformed internal diagnostic rejection, restart restores last safe projection.
  - Handoff: Center/menu bar safe view model.

## Wave 2 — 단일 담당 통합

- [x] **AH-200 — macOS Menu Bar/SKS Center를 신뢰성 UI에 연결한다**
  - 소유 범위: `native/sks-menubar/Sources/OperationCoordinator.swift`, `native/sks-menubar/Sources/OverviewViewController.swift`, `native/sks-menubar/Sources/ProvidersViewController.swift`, `native/sks-menubar/Sources/ProvidersOpenRouter.swift`, `native/sks-menubar/Sources/ProvidersMultiProvider.swift`, `native/sks-menubar/Sources/StatusItemController.swift`, `native/sks-menubar/Tests/OperationCoordinatorTests.swift`, `native/sks-menubar/Tests/ProvidersViewControllerTests.swift`
  - 선행 조건: AH-001, AH-102~AH-107, AH-114
  - 병렬 가능 여부: AH-300과 병렬; 이 파일들의 단일 소유자
  - 구현:
    - 모든 버튼/menu action의 handler → backend call → loading → result → recovery 전이를 inventory와 함께 연결한다.
    - mode/key/model/child/catalog/feature/apply-stage/progress/pause를 Center에서 모두 관리한다.
    - 메뉴바 최소 상태·설정 진입·복구 action은 backend/proxy/network 실패와 무관하게 살아 있게 한다.
  - 수용 기준: dead control, empty handler, ignored Promise, swallowed error, silent success가 없다. 키가 없으면 모델/child가 숨겨지고 자동 auth UI가 뜨지 않는다.
  - 테스트: Swift unit/state-machine test, accessibility label/action inventory, start/restart/offline/proxy/key/catalog/save failure, four-stage partial failure, existing-session/new-default copy.
  - Handoff: 화면별 action matrix와 macOS QA selector 목록.

- [x] **AH-300 — TypeScript/CLI/proxy choke point를 한 번에 통합한다**
  - 소유 범위: `src/core/codex-lb/desktop-service.ts`, `src/core/codex-lb/desktop-bridge/server.ts`, `src/core/codex-lb/desktop-bridge/http-forward.ts`, `src/core/codex-lb/desktop-bridge/security.ts`, `src/core/codex-lb/desktop-bridge/state.ts`, `src/core/codex-lb/desktop-bridge/types.ts`, `src/cli/install-helpers-codex-lb-config.ts`, `src/cli/router.ts`, `src/core/routes.ts`, `src/core/commands/image-ux-review-command.ts`, `src/core/image-ux-review/imagegen-adapter.ts`, `src/core/architecture-hardening/__tests__/integration.test.ts`
  - 선행 조건: Wave 1 전체 handoff 승인
  - 병렬 가능 여부: AH-200과 병렬; listed choke point의 유일한 통합 담당자
  - 구현: 새 contracts/state/policies를 실제 caller에 연결하고 legacy inline logic을 제거한다. barrel/package script는 수정하지 않고 direct imports를 사용한다.
  - 수용 기준:
    - UI가 우회되어도 proxy가 배타성, session pin, child snapshot, LB no-failover, OAuth auxiliary opt-in을 거부/허용한다.
    - router는 alias보다 effect contract를 먼저 적용하고 상위 계약의 evidence/retry budget을 하위 command가 재사용한다.
    - image workflow는 reference-only API를 사용하며 기본 경로에서 copy/upload하지 않는다.
  - 테스트: integration matrix로 transport identity, cross-mode negative paths, replay/replan, graph gate, legacy migration, image no-copy/no-network를 검증한다.
  - Handoff: end-to-end call graph, removed legacy branches, 남은 external protocol blockers.

## Wave 3 — 검증과 문서

- [x] **AH-400 — hermetic sandbox API/E2E를 구축한다**
  - 소유 범위: `test/e2e/architecture-hardening/**`, `test/fixtures/architecture-hardening/**`, `scripts/architecture-hardening-sandbox/**`
  - 선행 조건: AH-200, AH-300
  - 병렬 가능 여부: AH-401, AH-402와 병렬
  - 구현: temp HOME/CODEX_HOME/SKS_HOME, mock LB/OR/OAuth/catalog server, isolated Codex install, secret-safe log scanner를 제공한다.
  - 수용 기준: 사용자 로컬 설정/계정/Keychain을 읽거나 쓰지 않으며 세 mode, key withdrawal, session pin, child policy, four-stage apply, offline/restart/pause/resume를 재현한다.
  - 테스트:
    - 기본: mock contract E2E와 filesystem diff로 격리 증명.
    - 조건부 실연동: 승인된 정확한 `CODEX_LB_API_KEY`와 base URL env가 모두 프로세스에 안전하게 주입된 경우만 실제 Codex + LB를 실행한다. 값은 출력·기록하지 않는다.
    - 키가 없으면 `not_verified: secret_injection_required`로 종료하며 가짜 key나 사용자 설정으로 대체하지 않는다.
  - Handoff: 재현 명령, secret-free evidence paths, mock 결과와 live 결과의 분리 표.

- [x] **AH-401 — signed macOS 반복 재시작 QA를 수행한다** (fixture/gate 완료; live `not_verified: signed_app_required`)
  - 소유 범위: `native/sks-menubar/UITests/**`, `native/sks-menubar/QAFixtures/**`
  - 선행 조건: AH-106, AH-200
  - 병렬 가능 여부: AH-400, AH-402와 병렬
  - 구현: development와 production signing 영역을 분리한 UI QA fixture를 만든다.
  - 수용 기준: 최초 explicit 연결 이후 앱/메뉴바 여러 번 재시작에도 재인증 prompt가 없고, 삭제/손상/잠김/서명 차이는 상태와 수동 reconnect만 표시한다.
  - 테스트: signed helper service/account stability, launch/relaunch loop, offline/proxy/catalog/save failure, menu accessibility and recovery actions.
  - Handoff: signing identity 종류만 기록하고 식별자/credential은 기록하지 않은 QA matrix.

- [x] **AH-402 — 아키텍처·운영·migration 문서를 현재 동작과 맞춘다**
  - 소유 범위: `docs/architecture.md`, `docs/architecture/native-openai-exclusive-provider-modes.md`, `docs/codex-app.md`, `docs/codex-lb.md`, `docs/testing-hermetic-e2e.md`, `docs/architecture-hardening-migration.md`
  - 선행 조건: AH-200, AH-300; AH-400/401 status handoff
  - 병렬 가능 여부: 코드 merge 후 AH-400/401와 병렬 초안, 최종 상태 반영은 둘의 handoff 뒤
  - 구현: OpenCodex 방식의 상위 원칙, 세 mode, OAuth 보조, session pin, Center UX, Keychain, sandbox와 migration을 실제 구현 상태에 맞춰 문서화한다.
  - 수용 기준: policy/implemented/contract-tested/live-verified를 분리하고 legacy custom-provider 설명에 superseded/migration 표기가 있다.
  - 테스트: link/path check, docs truthfulness check, 금지된 silent fallback·user-config dependency 문구 검색.
  - Handoff: 문서별 source-of-truth 코드 링크와 미검증 목록.

- [x] **AH-499 — 루트 통합 검증과 상태 봉인을 수행한다**
  - 소유 범위: 소스 편집 없음; 이 파일의 체크박스/상태표만 루트 코디네이터가 갱신
  - 선행 조건: AH-400~AH-402 settled
  - 병렬 가능 여부: 최종 단독
  - 검증:
    - `npm run typecheck --silent`
    - `npm run build:incremental --silent`
    - 변경된 각 도메인의 focused `node --test`와 Swift test
    - architecture-hardening hermetic E2E
    - `git diff --check`
    - target/source ownership audit와 secret/user-config access audit
  - 수용 기준:
    - 실패한 protected gate가 하나라도 있으면 completed로 표시하지 않는다.
    - 일반 검증 미완료는 `unverified`, 재개 가능한 외부/설정 문제는 `paused`, 실제 오류는 `failed`로 분리한다.
    - mock/contract와 live evidence를 합치지 않는다.
    - live LB 또는 signed macOS QA가 실행되지 않았다면 이유와 필요한 주입/서명 조건을 명시한다.
  - Handoff: 최종 구현/계약 테스트/실환경 상태표, blocker, rollback point, Honest Mode.

## Merge 순서와 소유권 지도

| 순서 | 작업 | 쓰기 소유권 | 다음 단계에 주는 계약 |
|---|---|---|---|
| 1 | AH-000 | contracts 전용 디렉터리 | versioned 공통 타입/validator |
| 2 | AH-001 | state 전용 디렉터리 | draft/LKG transaction + read projections |
| 3 | AH-101~114 | 각자 명시된 비중첩 경로 | domain ports, reason codes, focused tests |
| 4 | AH-200 | 지정 Swift controller/test만 | Center action matrix |
| 4 | AH-300 | 지정 TS/CLI/proxy choke point만 | 실제 caller integration |
| 5 | AH-400/401/402 | sandbox, macOS UI QA, docs로 분리 | mock/live/docs evidence |
| 6 | AH-499 | 소스 쓰기 없음 | 최종 상태 봉인 |

금지된 공유 편집:

- `package.json`, `tsconfig*.json`, 공용 test runner, 공용 fixture index는 어떤 task도 편집하지 않는다.
- AH-200 이외 작업은 지정 Swift controller를 편집하지 않는다.
- AH-300 이외 작업은 `src/cli/router.ts`, `src/core/routes.ts`, bridge entrypoint, image legacy caller를 편집하지 않는다.
- AH-110 이외 작업은 지정 graph store 파일을 편집하지 않는다.
- AH-106 이외 작업은 `SKSKeychainStore.swift`를 편집하지 않는다.
- 문서 작업자는 소스 구현을 보정하지 않고 불일치를 blocker로 반환한다.

## 전체 완료 기준

- native Codex UI/catalog/metadata를 유지한 채 세 mode가 proxy에서 배타적으로 강제된다.
- 세션/포크/재개/child가 mode·model·credential class·policy snapshot을 보존하고 cross-mode/account failover를 거부한다.
- Keychain 최초 명시 승인 후 정상 재시작에서 prompt가 없으며 오류 시 자동 UI 대신 상태와 수동 reconnect를 제공한다.
- Center의 모든 control이 loading/success/failure/recovery를 가지며 apply 4단계를 독립 표시한다.
- IntentContract, EvidenceKey v2, graph lock/atomicity, reference-only image, pause/resume 불변식이 실제 caller에 연결되고 negative tests가 통과한다.
- hermetic sandbox는 사용자 로컬 상태 무접근을 증명한다.
- 실제 키/서명/외부 프로토콜이 없어 수행하지 못한 검증은 `unverified` 또는 `blocked`로 남고 mock 성공으로 대체되지 않는다.

## Rollback 원칙

- 각 task는 하나의 독립 commit으로 유지하고 domain commit부터 역순으로 되돌릴 수 있게 한다.
- AH-001은 last-known-good를 보존하므로 failed apply 시 staged draft만 폐기한다.
- provider migration은 inspect/plan/apply를 분리하고 apply 전 원본 설정의 권한·내용 hash를 보존한 백업 receipt를 만든다. 비밀 내용 자체는 receipt에 저장하지 않는다.
- graph commit 실패 시 current snapshot을 유지하고 staging만 폐기한다. previous snapshot을 자동 활성화하지 않는다.
- Keychain migration 실패 시 기존 항목을 삭제하지 않고 명시적 conflict/reconnect 상태로 남긴다.
- E2E fixture와 임시 Codex install은 격리 root만 제거하며 사용자 홈을 cleanup 대상으로 삼지 않는다.

## 계획 상태

- [x] 요구사항을 비중첩 ownership과 wave dependency로 분해함
- [x] 정책/구현/계약 테스트/실환경 검증 상태를 분리함
- [x] 계약 우선, 단일 통합 담당, handoff contract를 정의함
- [x] 제품/소스 구현 시작 — AH-000~114 독립 도메인 구현 및 focused 계약 테스트 완료
- [x] 계약 테스트 재실행 — AH-000~114 focused TypeScript/Swift 테스트 통과
- [x] sandbox mock E2E 및 signed QA fixture/gate 통과
- [ ] live LB — `not_verified: secret_injection_required`
- [ ] production-signed macOS QA — `not_verified: signed_app_required`
