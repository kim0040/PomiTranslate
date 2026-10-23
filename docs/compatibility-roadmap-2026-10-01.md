# 잔여 작업과 Minecraft 호환성 확대 계획 — 2026-10-01

사용자 요청: 남은 작업을 확인하고, Minecraft 버전에 따른 동작 차이를 줄이는 작업 계획을 세운다.

초기 계획 작성은 조사와 제안만 수행했다. 후속 사용자 요청으로 [샘플·시작 복구·최소 provider 검증](history/sample-startup-validation-2026-10-01.md)을 진행했다. 초기 조사 시에는 제품 소스 수정, 테스트·빌드·유료 API 실행, commit/push를 하지 않았다. Phase2 완료 근거는 [최종 검증](history/phase2-completion-2026-10-01.md), 최신 상태는 [현재 상태](current-state.md)에 따라 **Phase2 개발 환경 gate 완료 / Phase3 진행 중(COMP-01 완료) / release-ready 아님**이다. 2026-10-02 main 통합 상태와 남은 gate는 [추후 작업](follow-up-work.md)을 따른다. 조사 기준은 `main` / `2d32ebe`, 시작 시 working tree clean이다. 기존 검증 결과는 기록된 범위로만 인용하며 이번에 다시 실행한 결과가 아니다.

## 판단

**버전에 따라 일부 텍스트가 번역에서 빠지거나, 특정 월드 형식을 처리하지 못할 수 있다.** 현재 코어에는 여러 세대의 Java 형식 처리 기반이 있지만, 전체 Minecraft 버전별 실제 동작을 보증할 근거는 아직 없다.

호환성 확대는 기존 코어에 구조별 adapter와 증거를 추가하는 방식으로 진행한다. 월드 버전 하나로 전체를 판정하지 않고, 각 청크의 구조·압축·저장 위치와 번역할 필드를 함께 판단한다. 월드 업그레이드나 버전 변환은 수행하지 않는다. 알려진 사용자 표시 텍스트만 수정하고 식별자·명령 동작·미지의 데이터는 보존한다.

## 현재 근거와 공백

| 영역 | 확인한 현재 상태 | 작업 계획에 미치는 영향 |
| --- | --- | --- |
| 구형/양면 표지판, 책, 이름/lore | 처리 코드와 합성 fixture 지원 기록 있음 | 이미 되는 경로의 회귀를 유지하며 실제 버전별 표본 추가 |
| 1.20.5 이후 아이템 components | custom_name/item_name/lore/book 및 nested item 탐색 구현 | 개별 component와 버전별 표현 차이를 별도로 검증 |
| 1.21.5 이후 직접 NBT component | compound/list 처리 구현 | 직접 NBT 지원과 명령 문자열 SNBT 지원을 구분 |
| 명령 속 텍스트 | JSON/SNBT parser·span patch와 선행 `/`·문자열 component, 해석 실패 경고 구현(COMP-01) | 합성 fixture/E2E 기록 있음. 실제 게임 버전 생성/로드와 최신 component는 COMP-02/04 |
| 최신 component fallback | 2026-10-23 COMP-02: 26.1 object component의 text component fallback, show_item/show_entity hover 이름·lore, selector/nbt separator, mannequin description을 수집·기록(합성 fixture 검증; 게임 로드 미확인, `EXTRACTOR_VERSION` 5, 검토 수정 포함). 근거는 [COMP-02 기록](history/comp02-component-shapes-2026-10-23.md) | 실제 게임 버전 생성/로드는 COMP-04. 구형 `filtered_pages`·`attribute_modifiers` display·dialog 텍스트는 근거 미확인으로 미구현 |
| gzip/zlib/none/LZ4, 외부 .mcc | 처리 코드와 합성 round-trip 기록 있음 | 재구현보다 혼합 압축·대형 외부 청크·장애 복구 증거 보강 |
| 버전 정보 | level.dat DataVersion 조회; UI는 첫 유효 값 표시. core는 DataVersion으로 미검증/미래 버전을 명시적으로 차단하지 않고 shape로 처리 | 청크별 버전 분포·혼합 여부·unknown 및 근거 표시와 쓰기 허용 정책 추가 |
| 차원·서버 구조 | vanilla/custom dimension 및 선택한 서버 루트 내부 child world 탐색 | Paper 계열은 서버 루트 선택과 단일 월드 선택을 구분해 검증; 선택 범위 밖 자동 접근 금지 |
| 리소스팩 | 선택된 ZIP의 lang 파일을 JSON으로 파싱 | 구형 .lang, overlays와 pack metadata 변화는 별도 확인 필요 |
| 번역 범위 | region/entities 및 선택한 ZIP | datapack, command storage, scoreboard, level.dat 텍스트, playerdata는 현재 미지원 |
| 특수 형식 | Bedrock/.mcr/.linear 감지·차단, 미지 압축은 해당 region 쓰기 차단 | 원본 보호 유지; 신규 codec은 별도 우선순위와 실제 fixture가 확보된 뒤 결정 |
| 플랫폼 | 최신 개발 패키지는 macOS arm64 검증 기록 | Minecraft 파일 호환성과 OS 설치 호환성은 각각 완료 조건 필요 |

핵심 소스 근거:

- [extract.py](../mwt/extract.py): `_walk_command`의 JSON/SNBT 명령 처리와 직접 NBT component·아이템·표지판 탐색. [snbt.py](../mwt/snbt.py): `parse`/`SnbtDocument.render`의 원문 span 보존. 과거 조사 line 번호는 후속 구현으로 달라졌다.
- [desktop_entry.py](../mwt/desktop_entry.py): 217–280의 level.dat 기반 inspection. [WorldScreen.svelte](../src/screens/WorldScreen.svelte): 19, 52의 DataVersion 표시.
- [layout.py](../mwt/layout.py): 선택 루트 내부 차원/서버 탐색 및 특수 형식 차단.
- [region.py](../mwt/region.py): 압축 codec, 외부 청크, 원본 청크 보존. [mc_world_translator.py](../mc_world_translator.py): 1412–1433의 미지원 압축 쓰기 차단; 1629–1667의 pack 파일 선택/JSON 파싱.
- [support_matrix.py](../mwt/support_matrix.py), [현재 지원 표](support-matrix.md): 형식별 합성 결과이며 버전별 실월드 지원 표가 아니다.
- [test_release_fixtures.py](../tests/test_release_fixtures.py): 구형/신형을 묶은 합성 형태와 JSON/SNBT 명령. [test_snbt_commands.py](../tests/test_snbt_commands.py)는 escape·표현 보존·해석 실패 경고의 추가 근거다. [test_extraction.py](../tests/test_extraction.py): DataVersion 보존, 직접 component, modified UTF-8 등의 근거. 하나의 DataVersion을 보존하는 검사만으로 여러 버전 혼합 월드 검증을 대신할 수 없다.

위 누락 판단은 코드와 공식 변경 내역을 비교한 것이다. 해당 버전의 실제 게임 실행으로 재현한 결과는 아니다.

## 공식 형식 변화와 목표 버전군

- [Java 1.20.5 공식 변경 내역](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-5): 아이템 tag→components 변화와 LZ4 설정 추가. 압축 설정을 바꾸어도 기존 청크는 자동 재압축되지 않으므로 혼합 압축을 검증해야 한다.
- [Java 1.21.5 공식 변경 내역](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-5): 직접 NBT text component, tellraw/title SNBT, hover/click 필드 변화. `{text:'Hello'}`는 이전 JSON 전용 파서의 누락 입력이며 COMP-01의 SNBT parser·합성 fixture로 처리한다. 실제 해당 게임 버전 로드는 별도 미검증이다.
- [Java 26.1 공식 변경 내역](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1): object component의 구조화된 fallback 등 텍스트 변화. 기존 translate fallback과 별개의 구조로 검증한다.
- [Java 26.3 공식 변경 내역](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3): 2026-09-15 정식 출시, level.dat version_history 추가. 최신 세대 검증 목표에 포함하고 기존 버전 정보와의 관계를 확인한다.

| 목표 버전군 | 대표 검증 포인트 | 현재 지위 |
| --- | --- | --- |
| Java 1.2–1.12 | legacy chunk/표지판/책, 구형 .lang 팩; 우선 대표 1.12.2 | 검증 목표; 범위 전체 지원 선언 아님 |
| Java 1.13–1.19 | JSON component, names/lore, entity 저장 위치 전환 | 대표 경계 버전 추가 목표 |
| Java 1.20–1.20.4 | 양면/filtered 표지판 | 형식 기반 기록 있음; 버전별 표본 필요 |
| Java 1.20.5–1.21.4 | item components, LZ4, JSON 명령 | 형식 기반 기록 있음; 버전별 표본 필요 |
| Java 1.21.5–1.21.11 | 직접 NBT, SNBT 명령, hover/click 세부 변화 | SNBT 합성 검증 기록 있음; 버전별 실제 표본·게임 로드 필요 |
| Java 26.1/26.2/26.3 | 최신 component와 metadata, 팩 형식 변화 | 공식 내역 조사와 실제 생성 표본 추가 목표 |
| 모드/서버 Java | 표준 Anvil과 알려진 표시 텍스트; unknown 보존 | 제품/버전/구조별로 판단, 전체 모드 지원 선언 금지 |
| Bedrock/.mcr/.linear/custom compression | 안전한 식별·안내 | 쓰기 미지원 유지; adapter는 별도 후속 과제 |

표본은 먼저 구조가 달라지는 경계 버전에서 확보한다. 같은 형식을 쓰는 모든 patch 버전을 전수 실행하지 않는다. 합성 형태 통과와 실제 특정 게임 버전 검증을 각각 표기하고, 과거 전체 범위를 대표 한 버전의 성공으로 승격하지 않는다.

## 실행 순서와 완료 조건

### 1. Phase2 완료 조건 (완료 이력)

아래 P2-START/P2-PARITY/P2-API/P2-FINAL은 `c26fcd7`에서 완료·commit/push했다. 완료 조건을 보존하며 다음 작업으로 반복하지 않는다. 후속 native 변경은 UX-NATIVE-01의 별도 확인 대상이다.

| 순서 / ID | 작업 | 완료 조건 |
| --- | --- | --- |
| 1 / P2-START | 시작 지연·무응답 복구 | hello/bootstrap 각각의 deadline, 상태/오류/재시도, 소유 프로세스 정리; 지연/무응답/실패 및 native cold restart 확인. 과거 blank 원인은 재현 근거 없이 단정하지 않음. 쓰기 작업을 일괄 timeout으로 종료하지 않음 |
| 2 / P2-PARITY | legacy backup/checkpoint 대체 계약 | 안전한 항상 백업·앱 관리 checkpoint를 기본으로 제안; 기존 off/suffix/path와 차이 및 필요한 migration/설명을 문서화하고 최종 범위 결정. 대체 계약 완료 전 legacy 유지 |
| 3 / P2-API | 실제 provider 최소 E2E | 합성/복사본으로 최소 실제 번역; 요청/tokens/usage와 제공사가 확인 가능한 실제 비용 기록. 비용을 확인할 수 없으면 unknown. world4+외부ZIP1 백업·쓰기·복원, baseline SHA-256 차이0 |
| 4 / P2-FINAL | Phase2 최종 gate와 저장 | 최종 후보의 유효 증거 재사용 및 영향/잔여 위험 검사, native 최종 범위 확인, docs/diff/secret/artifact review → Phase 완료 commit → push |

P2-API는 저장된 사용자 key를 읽어 채팅/파일로 복사하지 않는다. 기존 승인된 추가 총 $1 이하, 목표 $0.01–$0.10의 최소 E2E 범위에서만 실행하며 이번 계획 작성에는 호출하지 않는다.

### 2. Phase3 첫 작업: 호환성을 우선 확대

| ID / 선행 조건 | 범위와 주요 파일 | 완료 조건 |
| --- | --- | --- |
| COMP-01 완료 / Phase2 완료 | `extract.py` command adapter에 JSON/SNBT 구분과 안전한 parse/patch 추가; 필요 모듈은 독립 분리 | tellraw/title 및 execute-run, click embedded command에서 작은따옴표/따옴표 없는 key/list/escape/nesting을 처리. 허용된 visible text만 변경; selector·resource ID·좌표·명령 이름 보존. parse 실패는 원문 유지+미처리 안내. 원래 표현을 유지하고 출력 재파싱 확인 |
| COMP-02 / COMP-01 | 직접 NBT/JSON의 최신 component adapter와 알려진 필드 보강 | 26.1 object fallback, 최신 hover show_item/show_entity, book filtered/raw, sign 관련 component를 공식 구조별 조사. 실제로 빠지는 형태만 최소 구현하고 각 fixture로 수집/쓰기/복원을 검증. bossbar/team visible text는 별도 command adapter로 추가 **2026-10-23 구현(합성 fixture 검증, 게임 로드 미확인):** object fallback·hover item/entity·separator·mannequin description, book/sign filtered는 기존 지원을 fixture로 고정([조사 출처·필드 비교](history/comp02-component-shapes-2026-10-23.md)). 남은 일: bossbar/team command adapter, 위 기록의 미구현 항목, 실제 게임 확인(COMP-04) |
| COMP-03 / COMP-01과 독립 조사 가능 | chunk DataVersion·shape·compression·layout coverage → JSONL/report/UI | level.dat 버전과 chunk별 관측을 구분. 혼합 버전·미지 버전·부분 미지원·검사하지 않은 파일을 표시. 미검증 버전/구조의 쓰기 허용 정책을 명시하고 기본은 scan/preserve. 후보0은 ‘이 월드에 번역할 글이 없다’는 증거로 사용하지 않음. report와 UI에 processed/skipped/unsupported/unknown 경계가 일치. **2026-10-23 구현(fixture·browser 검증, native 미확인):** scan이 chunk마다 DataVersion(있음/없음/읽지 않음)·압축·상태(processed / skipped_unsupported / unreadable / not_inspected)를 dimension·파일 종류별 개수로만 모으고(`mwt/coverage.py`, chunk 목록 없음) report의 `coverage`와 scan 응답의 `chunkCoverage`(기존 `coverage`는 범위 목록이라 이름을 분리)로 내보낸다. 기준 상수는 `mwt/support_matrix.py`의 `NEWEST_COVERED_DATA_VERSION`. **2026-10-23 정의 수정(리뷰 M5·L1·L2):** `processed`는 scan이 chunk를 읽고 글을 찾아본 것이며, 파일을 다시 쓸 수 없어도(미지 압축·불안전 섹터 표가 같은 파일에 있음) 그대로 `processed`다. 읽을 수 없는 미지 압축 chunk만 `skipped_unsupported`. 쓰기 불가 파일은 dimension·종류별 `writeBlockedFiles` 개수로 따로 보고(UI는 같은 scan의 `file_unwritable` 경고가 이미 보여 주므로 요약에 중복 표시하지 않음). 파일당 distinct key 상한을 넘은 chunk는 상태별 overflow로 세고 분포에 `truncated`를 표시하며, mixed/missing/newer 플래그와 범위는 파일별 정확한 최소·최대·결측 값으로 유지. 체크포인트에서 이어 한 scan의 `partial` 표시는 다음 체크포인트에도 남는다. 쓰기 정책은 아래 문단 |
| COMP-04 / COMP-01–03 안정화 | 버전 manifest와 대표 실제 생성 월드, 기존 compression fixture 보강 | 경계 버전별 scan→결정적 번역→write→reopen→비대상 보존→restore hash 검사. 같은 월드/region에 구형·신형 shape, 서로 다른 DataVersion/압축을 섞어 검증. external .mcc·entity/custom dimensions/Paper 루트·large/corrupt/emoji/NUL 포함; 255-sector 내부 한계 전후와 번역 후 신규 .mcc 생성·백업·복원·중단 복구를 추가 |
| COMP-05 / 안전한 coverage 계약 | 구형 pack .lang, JSON lang, locale/metadata/overlay 호환성; `desktop_resource_packs.py`와 pack writer | .lang 별도 parser/serializer와 escape/placeholder 보존. 실제 사용하는 overlay/pack metadata 형태를 조사하고 지원 또는 detected로 명시. folder/fill/merge는 아래 CONTENT 과제와 결합하며 ZIP 안전 경계를 유지 |
| COMP-06 / 버전별 증거 확보 | support matrix 생성기를 버전·형식·범위·출처 기반으로 보강 | 정확한 게임 버전/DataVersion, fixture 종류, source fingerprint, scan/write/reopen/restore 및 실제 게임 로드 결과를 기록. 신규 버전은 공식 변경 내역 조사 후 영향 fixture만 추가. 버전군 전체를 자동 supported로 표시하지 않음 |

실제 게임 버전의 지원 승격은 그 버전으로 만든 작은 표본을 번역하고 해당 게임에서 다시 열어 텍스트 표시와 원본 기능 보존을 확인하는 증거까지 포함한다. 게임 환경이 없으면 fixture verified만 표시하고 실제 게임 검증은 미완으로 남긴다. 생성 월드/로그/스크린샷은 Git 제외, fixture generator와 공개 가능한 기대값만 추적한다.

COMP-03의 기본 제안은 미검증/미래 DataVersion에서는 읽기 전용 scan과 보존을 우선하고, 검증된 구조 profile·안전성 증거가 확보된 범위에만 쓰기를 허용하는 것이다. DataVersion 누락·혼합은 구형 월드에서도 가능하므로 버전 숫자만으로 모두 거부하지 않고 구조별 증거로 분류한다. 어떤 조건이 쓰기를 허용하는지 backend와 UI에 같은 계약을 두며, 사용자의 강제 실행 선택만으로 미지 구조가 검증된 것으로 바뀌지는 않는다. 2026-10-23 결정: 숫자만으로 쓰기를 막지 않고, 구조를 검증한 chunk는 지금처럼 쓴다. 기준 상수보다 새로운 chunk가 있으면 UI가 번역 전에 경고하고 scan마다 한 번 명시적 확인을 받으며, `translate.start`/`translate.resume`은 `acceptNewerVersion: true` 없이는 `NEWER_VERSION_UNCONFIRMED`로 거절한다(저장된 scan plan의 `chunkCoverage.flags.newer`로 판단하므로 클라이언트를 믿지 않는다). 미지·미지원 구조와 미지 압축 파일은 지금처럼 보존한다. 후보 0건은 검사하지 못한 chunk/파일이 있으면 ‘글이 없다’가 아니라 무엇을 검사하지 못했는지로 안내한다.

미지 압축이 섞인 region 전체 쓰기 차단과 선택 루트 밖 경로 차단을 유지한다. 향후 부분 쓰기를 허용하려면 원본 청크 보존과 복구가 먼저 검증되어야 한다. `.linear`가 섞인 월드의 표준 부분을 읽기 전용으로 보여주는 개선부터 고려한다. 초기 조사에서 없던 신규 .mcc 생성 경계 fixture를 후속 Phase2 안전 수정으로 추가했다. 경계3/write failure2/validation4/recovery와 native 생성·복원·물리 집계는 완료했다. 실제 프로세스 kill 전체 복구와 게임 로드는 남아 있다.

### 3. Phase3의 나머지 제품 작업

| 묶음 | 남은 작업 | 완료 조건 |
| --- | --- | --- |
| CONTENT | datapack visible text/command storage/scoreboard 조사, opt-in adapter; external folder pack/fill/merge | 파일 유형별 known text와 동작 데이터 분리, collision/path/백업/복원 검사. 미지원 playerdata/level.dat 텍스트는 자동 scope 확장하지 않고 조사 후 별도 계약 |
| DATA | occurrence별 include/exclude, 전체 위치 lazy query; scan/override/checkpoint/resume migration; 후보/occurrence/glossary/TM/job history SQLite | identity·revision·world 격리, indexes, migration/rollback, 이전 job 재개 호환; 기존 credential vault와 데이터 범위 구분 |
| QUALITY | world/global glossary, revision/context-aware TM, 편집/삭제/import/export; provider 가격 시각·token/cost low/high와 resume 잔여량 | revision이 다른 번역 재사용 방지, 잘못된 TM 무효화, 추정과 실제 usage 구분; 확인되지 않은 가격은 unknown |
| RECOVERY | crash/kill 후 interrupted 복구·consistency 검사, restore/resume/discard | .mca/.mcc/ZIP 다중 파일 작업이 중단돼도 원본/백업/진행 상태가 일치; 실제 프로세스 중단 후 복구 증거 |
| UX/MAINT | 자연스러운 core/desktop 모듈 분리와 CLI/legacy 호환; screen reader/high contrast/font size/density; diagnostics redaction/cache·TM 삭제 | 변경 범위별 회귀와 실제 사용 흐름 확인. 기존 public settings import/export/reset은 재구현하지 않고 신규 schema와 연결 |
| LEGAL-01 | target별 binary dependency 목록/SBOM/license/NOTICE, MPL source·Python/native library 안내 | 실제 배포물 포함 목록과 고지 동봉, About에 target별 notice/SBOM과 실제 version/commit 연결; 미해결 충돌 플랫폼 배포 보류 |
| PLATFORM-01 | macOS arm64/Windows x64/Linux x64 clean-machine, OS keychain opt-in/import; macOS Intel 목표 결정 | 개발 런타임 없는 목표 OS의 설치·chooser·permission·저장·restart·backup/restore. artifact 생성만으로 지원 표시하지 않음 |
| RELEASE-01 | installer 구성 확인, signing/notarization/updater/rollback | 승인된 signing credential로 검증; update 전후 데이터 보존과 진행 중 write 처리 확인. 공개 릴리스는 별도 승인 |
| DOCS-01 | README/user-guide/privacy/support matrix/화면 갱신 | 구현·fixture·native·실제 provider·게임 버전·플랫폼·release evidence를 서로 구분하고 Phase3 gate 완료 후 commit→push |

데이터 기반 기능보다 **명령 SNBT → 최신 component → 혼합 버전 coverage/검증**을 먼저 진행한다. 이를 통해 사용자가 이미 가진 월드의 텍스트를 더 많이 정확하게 처리하는 데 우선 투자한다. Bedrock과 특수 region codec은 별도의 큰 작업이므로 표준 Java 호환성 확대 후 다시 우선순위를 정한다.

## 검증 실행 계획

[verification-policy](verification-policy.md)를 따른다. 구현을 안정화한 다음 변경 범위에 필요한 검사만 실행하고, 유효한 같은 입력 PASS는 재사용한다.

1. command/component: 관련 extraction fixture와 release fixture의 영향 case, 결정적 mock 번역. 각 신규 adapter에 입력·기대 후보·보존 값·출력 재파싱을 명시한다.
2. DataVersion/coverage: 혼합/unknown backend·JSONL 계약과 해당 World/Scan/Result UI scenario. 모든 viewport/locale matrix를 매 변경마다 실행하지 않는다.
3. pack: 관련 pack preflight/설정/외부 ZIP 회귀와 copy restore hash. 변경하지 않은 청크·entry는 원본 보존, 변경한 component는 비대상 의미 보존을 각각 확인한다.
4. Phase 후보가 안정되면 최종 관련 core/contract/browser gate를 한 번 묶고, Python/package 변경이 있을 때 sidecar를 갱신해 마지막 native gate를 수행한다.
5. 공식 버전별 게임 로드와 OS clean-machine은 자동 fixture와 별도 evidence다. 전체 Cartesian matrix를 기본 실행하지 않고 경계·혼합·실패·대형 입력을 선별한다.

## 다음 착수점

2026-10-01 후속에서 **COMP-01을 구현·검증**했다([기록](history/native-ux-and-compat-2026-10-01.md)). 다음은 COMP-02(최신 component)와 COMP-03(chunk별 DataVersion/coverage)이다. 아래 문단은 COMP-01 착수 전 기록이다.

후속 세션에서 **P2-START 개발 환경 회귀와 P2-API 최소 E2E**를 검증했다. 공개5 region과 Roguefire 복사본 총9435청크를 읽고, 실제 혼합 DataVersion4556/4440을 관측했으며 복사본12후보 쓰기·복원을 통과했다. 게임 로드와 경계 버전 텍스트 샘플은 아직 없다. 후속 최종 검증에서 **P2-PARITY 문서화한 대체 범위와 P2-FINAL 개발 환경 gate**를 완료했다. Phase2 완료 commit/push 후 다음 착수점은 **COMP-01 SNBT 명령 지원**이다. 시작할 때 Git/WIP와 최신 인계를 다시 확인한다. 이 계획만으로 미검증 버전 지원 문구나 Phase 상태를 변경하지 않는다.
