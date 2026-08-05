# Sneakoscope Codex 8.0.5 / TriWiki Cleanup 인수인계

작성일: 2026-08-05  
저장소: `/Users/weklem/Desktop/devs/Sneakoscope-Codex`

## 현재 계약

이번 변경의 TriWiki 계약은 다음 두 명령으로 분리된다.

- `$sks-cleanup`: 활성 TriWiki를 영구적으로 빈 상태로 만든다.
- `$sks-align`: cleanup 수행 여부와 관계없이 현재 저장소 소스 코드를 다시 읽어 활성 TriWiki를 코드 탐색 인덱스로 교체한다.

cleanup과 align은 서로 독립적이다. align은 cleanup receipt를 요구하지 않으며, 기존 TriWiki가 없거나 잘못되어 있거나 정상인 모든 경우에 전체 재구축을 수행한다.

## `$sks-cleanup` 구현 상태

핵심 구현은 다음 파일에 있다.

- `src/core/triwiki/triwiki-cleanup.ts`
- `src/core/commands/cleanup-command.ts`
- `src/core/triwiki/agents-md-projector.ts`

명령 형태:

```text
sks cleanup plan [--json]
sks cleanup run --apply [--json]
sks cleanup status [--json]
sks cleanup proof [--json]
```

동작 계약:

- `plan`은 활성 대상의 경로, 종류, 크기, 내용 digest와 managed `AGENTS.md` projection hash를 계산하며 파일을 바꾸지 않는다.
- `run`은 명시적인 `--apply` 없이는 거부한다.
- 적용 시 plan과 현재 내용을 다시 대조한 뒤 활성 TriWiki, 활성 memory, graph/cache/report와 TriWiki projection을 제거한다.
- 삭제 대상은 작업 중 프로젝트 내부 임시 디렉터리로 옮기지만, 성공 시 임시 디렉터리 자체를 삭제한다.
- backup, quarantine, restore용 이전 세대는 남기지 않는다.
- 실패가 영구 삭제 시작 전에 발생하면 임시 이동과 projection 편집을 원래 상태로 되돌린다.
- 성공 receipt는 저장소 realpath에 바인딩되며 빈 상태를 다시 검증한다.
- 반복 실행은 이미 검증된 빈 상태 receipt를 재사용한다.
- 저장소 소스, 일반 문서, mission/evidence, release proof bank는 삭제 대상이 아니다.

활성 삭제 대상에는 `.sneakoscope/wiki`, `.sneakoscope/memory`, 관련 graph cache/report, generated projection, 오래된 TriWiki 임시 세대가 포함된다. 기존 cleanup quarantine 경로도 활성 TriWiki의 이전 복사본으로 취급해 제거한다.

## `$sks-align` 구현 상태

핵심 구현은 다음 파일에 있다.

- `src/core/align/align-route.ts`
- `src/core/align/code-navigation-align.ts`
- `src/core/commands/align-command.ts`
- `src/core/triwiki/code-navigation-policy.ts`
- `src/core/triwiki/code-navigation-context-pack.ts`
- `src/core/triwiki/context-graph/extractors/code/**`

명령 형태:

```text
sks align prepare ["scope"] [--json]
sks align run [mission|"scope"] [--json]
sks align status [mission|latest] [--json]
sks align proof [mission|latest] [--json]
```

전체 재구축 순서:

1. 현재 저장소에서 허용한 모든 소스 파일을 읽고 hash, 언어, 줄 수, 크기, source-leading purpose를 기록한다.
2. prior TriWiki, memory, wrongness, missions, proofs, 일반 문서, 외부 문서를 입력으로 사용하지 않는다.
3. fragment cache 없이 code extractor 하나만 실행한다.
4. file/symbol/test/module node와 source-provenance relation을 만든다.
5. inventory와 file node가 정확히 일치하는지 확인한다.
6. 소스를 다시 읽어 scan 전후 inventory digest가 같은지 확인한다.
7. graph, manifest, code pack, context pack을 staging에서 모두 검증한다.
8. 기존 활성 세대를 임시 handle로 옮기고 새 wiki를 승격한다.
9. managed `AGENTS.md` projection을 적용하고 artifact hash를 기록한다.
10. 성공 시 이전 세대와 staging handle을 영구 삭제한다.

`context-graph.json`이 전체 탐색 권위다. `context-pack.json`과 managed `AGENTS.md` block은 빠른 초기 탐색을 위한 bounded projection일 뿐 전체 파일 목록을 대신하지 않는다.

## 코드 extractor의 정확한 범위

TypeScript/JavaScript는 TypeScript compiler API를 사용해 declaration, import, re-export, reference/call 탐색 관계를 만든다.

그 밖의 지원 확장자는 현재 바이트 전체를 읽어 file node와 hash를 반드시 만들며, 명시적인 한 줄 declaration만 보수적인 언어별 matcher로 symbol node에 추가한다. 이 경로는 각 언어의 완전한 compiler/parser라고 주장하지 않는다. 다중 행 또는 복잡한 매크로 declaration은 놓칠 수 있고, 추론한 call/import graph를 만들지 않는다. 발견한 symbol의 line/column은 해당 소스 줄의 literal identifier 위치다.

지원 inventory에는 Python, Ruby, Go, Rust, Java/Kotlin/Scala/C#, Swift, PHP, C/C++, shell, Vue/Svelte, Dart, Objective-C, Perl, Lua, Elixir, Clojure, Haskell, OCaml, Julia, SQL, R이 포함된다. Ruby class/method와 C++ struct/function을 포함한 대표 polyglot 좌표 회귀 검사가 있다.

다음 상황은 완전한 코드 인덱스라고 주장할 수 없으므로 align을 fail-closed한다.

- 지원 소스 확장자의 binary 또는 oversized 파일
- workspace 밖으로 나가는 symlink
- 읽기 실패
- file/node/edge/time cap 도달
- scan 중 source inventory 변경

## 생성 artifact

활성 generation은 다음 다섯 파일로 제한된다.

```text
.sneakoscope/wiki/context-graph.json
.sneakoscope/wiki/context-graph.meta.json
.sneakoscope/wiki/code-navigation-manifest.json
.sneakoscope/wiki/code-pack.json
.sneakoscope/wiki/context-pack.json
```

align ledger와 gate는 mission 디렉터리에 기록한다. gate는 code-only source policy, full rebuild, fatal skip 0건, file coverage, source CAS, staged publication, 이전 세대 미보존, 활성 artifact/projection hash를 모두 확인한다.

## 회귀 검증

집중 검증 대상:

```text
npm run typecheck
npm run build --silent
node --test --test-concurrency=1 \
  dist/core/commands/__tests__/align-command.test.js \
  dist/core/triwiki/context-graph/extractors/code/__tests__/code-extractor.test.js \
  dist/core/triwiki/context-graph/extractors/code/__tests__/code-extractor-limits.test.js
```

주요 검증 케이스:

- cleanup plan 무변경, 명시적 apply, content-bound 삭제, 반복 실행
- cleanup 후 backup/quarantine/임시 세대가 남지 않음
- 기존 또는 absent TriWiki에서 align 성공
- prior memory/docs/missions/proofs sentinel이 생성 artifact에 유입되지 않음
- 내부 TypeScript symbol과 source purpose 보존
- Python, Swift, Rust, Ruby, C++ declaration 좌표
- source 디렉터리 이름이 `build`여도 루트 generated `build`와 혼동하지 않음
- binary, oversized, symlink escape, cap을 조용히 건너뛰지 않음
- 동일 입력의 deterministic extractor 결과
- TypeScript path alias, barrel, dynamic import, reverse dependency closure
- 활성 artifact 변경 시 align gate 실패

## 이 파일 범위 밖의 남은 통합

core command 구현만으로 dollar/chat surface가 자동 노출되지는 않는다. 다음 담당자는 현재 CLI/dollar-command 등록 방식에 맞춰 `$sks-cleanup`과 `$sks-align`을 등록하고, packed surface에서 실제 routing을 검증해야 한다.

- route registry와 command dispatch
- CLI manifest/lite manifest
- dollar-command skill/command manifest
- package 포함 계약과 packed black-box command test

이 인수인계 작업에서는 해당 등록 파일을 수정하지 않았다. 또한 commit, push, tag, publish도 수행하지 않는다.

## 릴리스 주의사항

- retired multiplexer 이름과 변형은 active tracked filename/content zero-scan에서 0건이어야 한다.
- 과거 버전 전용 Codex 호환 표면을 되살리지 않는다.
- 최종 source 변경 뒤 release stamp는 다시 생성해야 한다.
- 최종 통합 담당자가 focused 검사, typecheck, 전체 release check, package dry-run의 retired-surface scan을 순서대로 실행한다.
