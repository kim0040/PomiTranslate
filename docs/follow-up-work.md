# 추후 작업 — 2026-10-04

**Phase2 데스크톱 기능·macOS arm64 개발 환경 gate 완료 / Phase3 진행 중(COMP-01 완료) / release-ready 아님.** 이 문서는 미완 작업의 기준 목록이다. [최종 완료 증거](history/phase2-completion-2026-10-01.md)는 플랫폼·정식 배포 완료와 구분한다. 최신 구현은 [현재 상태](current-state.md), 범위별 증거는 [검증 이력](history/README.md)을 따른다.

2026-10-01 사용자 요청에 따른 [잔여 작업·Minecraft 호환성 확대 계획](compatibility-roadmap-2026-10-01.md)은 현재 코드의 버전/형식 공백과 실행 순서·완료 조건을 정리한 제안이다. Phase2 완료 후 Phase3에서 SNBT 명령·최신 component·혼합 버전 검증을 우선한다. 초기 계획 작성 자체는 지원 범위나 Phase 상태를 변경하지 않았으며, 후속 구현·최종 검증으로 Phase2 개발 환경 gate를 완료했다. 후속 요청의 [샘플·시작 복구·실제 provider 검증](history/sample-startup-validation-2026-10-01.md)을 추가했으며 게임 버전 전체 지원은 선언하지 않는다.

## 지금 할 순서 (2026-10-02 main 통합 기준)

[main 통합·잔여 작업 대조](history/main-integration-2026-10-02.md)에서 `e97261c`의 코드와 문서를 대조했다. 도움말·초기화·화면 모드·업데이트 연결까지 구현됐으며, 이전 Linux 검증 기록과 이번 코드 확인을 구분한다. 아래는 실제로 남은 작업의 권장 순서다. 아래 표의 ID와 완료 조건이 기준이다.

1. **UX-NATIVE-01 — macOS 실제 확인(사용자 로컬 필요).** Linux에서는 컴파일·fixture로만 확인했다. `pnpm desktop:dev`(sidecar 빌드 포함)로 overlay 타이틀바·메뉴(도움말 메뉴·업데이트 확인 포함)·⌘Q·drop·saves 목록·Dock 진행률·다크 시작·외부 링크가 브라우저로 열리는지·데이터 폴더 열기·초기화 후 재시작을 본다. 결함은 native-only 재현 후 수정.
2. **PROVIDER-01 — Gemini 후속.** sidecar가 요청마다 새로 떠서 thinking 최저 단계 학습(`_GEMINI_LEVEL_FLOOR`)이 작업마다 초기화된다(작업당 거부 요청 1회, 동시 batch 수만큼 늘 수 있음). 모델 catalog 캐시에 저장하고, 비 OpenRouter 제공사의 날짜 명시 가격표 기반 비용 추정, 모델 목록에서 robotics/computer-use 등 번역 부적합 모델 정리.
3. **COMP-02 → COMP-03 → COMP-04** ([호환성 계획](compatibility-roadmap-2026-10-01.md)): 최신 component(26.x object fallback, hover/book/sign), chunk별 DataVersion·coverage UI, 1.21.5+로 실제 생성한 맵의 번역·게임 로드 확인.
4. **QUALITY-01 — 번역 품질.** 고유명사 유지/번역 일관성(실측: "Elder Mira"가 모델마다 다름), lite 모델 군더더기 글자(`§lcrypt`→`§lc지하실`) 같은 서식 인접 오류 감지, glossary·TM(Phase3 QUALITY).
5. **UX-WEB-01**(2026-10-04 개편 후 U20만 남음), **UX-NATIVE-02**, 그다음 **CONTENT(datapack `.mcfunction`)**, **DATA/RECOVERY**, 마지막으로 **LEGAL-01 / PLATFORM-01 / RELEASE-01**.

## 다음 작업의 우선순위와 완료 조건

| ID | 작업 | 현재 경계·선행 조건 | 완료 조건 |
| --- | --- | --- | --- |
| P2-API 완료 | 실제 provider 최소 E2E | 최소 E2E PASS: 합성3문장/1요청, provider-reported $0.0001484, world4+ZIP1 hash 차이0 복원 | 합성 world에서 mock 성공 후 최소 실제 번역; endpoint·요청/tokens/실제 cost·usage 전후 기록, verified backup/restore와 world4+ZIP1 baseline hash 차이0 |
| P2-START 완료 | startup 지연·무응답 복구 | 개발 환경 targeted/native PASS: hello30초/bootstrap60초 오류·cleanup·retry/cold Ready. 과거 blank 원인·clean-machine는 미확정 | 무응답/지연 sidecar·저장소 fixture, handshake/bootstrap deadline·오류 안내·소유 process cleanup; native 재시작 증거. write 전체에 무조건 timeout을 적용하지 않음 |
| P2-PARITY 완료 | 문서화한 Legacy 대체 범위 | 항상 백업·앱 관리 backup/checkpoint 유지, off/suffix/path 차이 명시 | 기존 안전 구현의 범위·literal import·legacy restore 검증. 동등 옵션/100% parity 아님, Legacy 유지 |
| P2-FINAL 완료 | 최종 Phase2 개발 환경 gate | Python20/frontend58/build/Rust28, browser86+수정 후 영향7 및 최종 native .mcc PASS | 검증·증거 재사용 경계 명시, docs/diff/secret/artifact review→완료 commit/push. 플랫폼/release gate 별도 |
| UX-NATIVE-01 | 네이티브 UX 후속의 macOS 확인 | 2026-10-02까지 구현·Linux Rust30/browser114 PASS 기록. 이번 통합에서 재실행하지 않음. [기록](history/native-ux-and-compat-2026-10-01.md) | Python 변경이 있으므로 sidecar 재빌드 후 macOS dev app에서 overlay 타이틀바·신호등·드래그 영역, 메뉴 라벨/단축키, ⌘Q 보호(작업 중), 폴더 drop, saves 목록, Dock 진행률/attention, 다크 시작·OS 화면 모드 변경, 도움말·라이선스 메뉴, 외부 링크·데이터 폴더 열기, 초기화 후 재시작·백업 유지·키 삭제/유지를 확인하고 결함 수정. 2026-10-04 추가분: 창 X·⌘Q 저장 확인(설정·도우미·용어집·검토 수정본)과 작업 중 종료 보호의 마지막 경계, OS 완료 알림 권한·전달·억제, 창 크기·위치·최대화 복원과 모니터 변경 |
| UX-WEB-01 | 남은 화면 UX 문제 | 2026-10-04 개편으로 U1–U19와 상용 수준 평가 항목을 고쳤다([기록](history/ux-overhaul-2026-10-04.md)). 남은 것은 원문 `lang` 판별(U20)과 native에서만 확인할 수 있는 검증 공백. [목록](ux-issues.md) | 목록 항목 수정 → 해당 browser 시나리오 PASS, native 관련 항목은 UX-NATIVE-01에서 확인 |
| UX-NATIVE-02 | 남은 네이티브 다듬기 | 2026-10-04 후보 행 우클릭 메뉴·창 크기/위치 기억은 구현(native 미확인) | 사이드바 vibrancy(투명 창 필요 여부 결정), Windows Mica/타이틀바 확인 |
| PROVIDER-01 | Gemini·비 OpenRouter 제공사 후속 | 2026-10-01 최신 모델 실측 완료: 3.8/3.7 flash·pro·`flash-latest`는 minimal 거부 → 자동 단계 상승 구현. 학습한 단계는 프로세스 메모리에만 있음 | 단계 학습을 catalog 캐시에 저장해 작업 간 재사용(동시 batch에서도 거부 1회 이하), Gemini/OpenAI/Anthropic 가격을 날짜·출처와 함께 추정에 반영(확인 불가 시 unknown), 번역 부적합 모델(robotics, computer-use 등) 목록 정리, 변경마다 최소 실제 호출로 확인. 2026-10-04: 번역 부적합 모델 숨김·사용자 입력 단가·추론 여유 추정 구현, 날짜·출처 있는 제공사 가격표와 Gemini 단계 학습 캐시는 남음 |
| QUALITY-01 | 번역 품질 보강 | 2026-10-04 전역·월드별 용어집(프롬프트 주입·불일치 1회 재요청·변경 시 적용 차단)과 적용 전 검토 구현. 서식 코드 인접 군더더기 감지·TM은 미구현 | 서식 코드 바로 뒤 원문 잔여 글자 감지(경고 또는 재시도), translation memory, 모델별 비교 fixture(합성)로 회귀 확인, 실제 제공사로 용어집 비용·재요청 실측 |
| COMP-02–06 | 호환성 확대 | COMP-01 완료. 나머지는 [호환성 계획](compatibility-roadmap-2026-10-01.md) | 계획 문서의 각 완료 조건 |
| LEGAL-01 | 배포물 라이선스·고지 | source MIT 유지. 2026-10-02 앱 안 고지 생성기(`pnpm licenses`, Rust 415/JS 21/Python 16, 데스크톱 build에서 플랫폼별 재생성)와 정보 화면 뷰어 추가. 법적 검토·MPL source 안내 확인·SBOM은 미완 | target별 포함 목록·SBOM·전체 license/NOTICE·MPL source 안내·Python/native library 고지를 package에 동봉. 충돌 미해결이면 해당 배포 보류 |
| PLATFORM-01 | clean-machine·키체인 | macOS arm64 개발 앱·Local/Session 검증; OS keychain opt-in/Windows/Linux native 미완 | Python/Node/Rust 없는 각 목표 OS에서 설치·chooser·credential permission/import·restart·backup/restore 확인; macOS Intel 목표 결정 |
| RELEASE-01 | 서명·업데이트·설치 배포 | unsigned 개발 bundle. 2026-10-02 updater 연결(확인·서명 검증 설치·작업 중 거부·재시작), 키 없는 빌드는 알림+다운로드 페이지. **공개키 비어 있음, `latest.json` 게시 없음** ([업데이트·데이터](updates-and-data.md)) | 승인 후 updater 키 생성·공개키 commit·secret 등록, release에 서명 파일+`latest.json` 게시, 이전 버전→새 버전 설치·재시작·설정/키/백업 유지·작업 중 거부를 각 OS에서 확인. macOS 공증·Windows 코드서명 |
| DOCS-01 | 문서·화면 유지 | 서비스 소개·면책·개발 안내 정리, 2026-10-02 README/사용 안내/개인정보/면책4언어·문자 에셋20개·UI ko/en/ja 소개 화면9장 현지화 ([관리](localization.md)) | 기능/지원/credential/가격 정책이 바뀔 때 4개 언어의 문구 catalog·사용자 문서·화면을 함께 갱신; 중국어 문서와 미제공 중국어 UI를 구분. 목표를 검증된 기능으로 표시하지 않음 |

## 이번에 완료한 범위

- [x] 2026-10-04 상용 수준 UX 개편(서명 제외): 적용 전 검토·수정 재적용·실패만 재시도·비용 한도·용어집·설정 도우미·설정 탭·닫기 보호·완료 알림·창 복원·중국어 UI, 독립 검토 R1/R2 지적 수정. check 0/0·frontend108·Python 전체·Rust63·browser260. [기록](history/ux-overhaul-2026-10-04.md)
- [x] 2026-10-02 후속: 도움말 화면·메뉴(F1/⌘?), 첫 실행 시작 안내, 앱 안 오픈소스 라이선스(생성기), Minecraft 비공식 고지 원문, 외부 링크를 기본 브라우저로(허용 목록), 앱 안 업데이트(서명 키가 있을 때만 설치), 데이터 위치 표시·열기, 두 단계 초기화(백업 유지), 설정 파일 fsync·사본·손상 복구, 테마·안내 동의를 설정 파일로 이전. Python23/Rust29/frontend62/browser108. [업데이트·데이터](updates-and-data.md)
- [x] 2026-10-02 화면 모드: 설정의 시스템/라이트/다크 미리보기 타일(즉시 적용·설정 파일 저장·작업 중이면 끝난 뒤 저장 재시도), 보기 → 화면 모드 메뉴와 체크 표시, OS 변경 실시간 추적, `theme-boot.js`와 Rust 시작 시 창 배경으로 다크 시작 깜빡임 제거, 다크 정보 화면 로고, 전 화면 다크 axe. Rust30/browser114. macOS·Windows 실제 창에서 깜빡임·타이틀바 색은 UX-NATIVE-01에서 확인.

- [x] 2026-10-01 후속: COMP-01 SNBT 명령(선행 `/`·문자열 컴포넌트 포함, 미해석 경고), Gemini thinking/사고 토큰/헤더 인증/잘림 처리, 서식 토큰 완전 일치 검사, 기본 창 크기 후보 표 원문 열 결함 수정, 데스크톱 셸·밀도·메뉴·drop·saves 목록·진행률·⌘Q 보호. Python22/Rust28/browser94, 실제 Gemini 13요청. [기록](history/native-ux-and-compat-2026-10-01.md)

- [x] 신규 .mcc 생성 경계·백업·중간 write 실패·recovery roundtrip와 물리 파일 집계 수정. 최종 native 변경2/API0/원래2파일 복원 hash 차이0.
- [x] Legacy 대체 범위와 최종 개발 환경 gate 정리. SourceOverrides 오류 해소 시 입력창 닫힘 수정, Python20/frontend58/browser 영향7 PASS.

- [x] 실제 샘플6개에서9435청크 읽기·NBT byte-identical·원본 보존. Roguefire 복사본12후보 쓰기/reopen/전체117파일 복원 hash 차이0. 공개5개는 후보0으로 쓰기 검증 대상이 아님.
- [x] startup 절대 deadline·오류·재시도와 무응답 native cleanup, frontend58/browser-startup5/Rust28/build 및 Python 영향 검사.
- [x] 합성3문장 실제 OpenRouter 번역1회, 입력391/출력108 tokens, provider 비용$0.0001484, 실제 backup/restore world4+ZIP1 hash 차이0.
- [x] 승인된 추론/설정 여섯 UI/UX 개선과 고정 sidebar/savebar.
- [x] 모델 공개 조회와 설정 저장 분리, default/disable/custom·지원 강도·캐시/오류 상태.
- [x] 관련 frontend28/browser30(29+1)/Rust24·Python provider 두 파일·최종 build·native 저장/재시작/기본값 복원. [정확한 범위](history/settings-ux-2026-10-01.md)
- [x] 외부 ZIP manual run/backup/restore와 물리 변경 파일 집계 수정. 이전 native 기준5파일 hash 차이0.
- [x] 검증 executor/cache/invalidation/cancel/lock 후속 및 screenshot 중복 통합. 이전 최적화 증거를 보존한다.
- [x] README 서비스 소개·사용법·실제 UI 화면, contributor·MIT·면책/개인정보·제3자 검토 문서.
- [x] 과거 인계를 history로 이동하고 현재 상태와 미완 작업을 분리; runtime/world/DB/key/report 생성물 Git 제외.

이전 전체19 Python/50 frontend/71 browser PASS는 UX 이전 소스의 이력이다. 위 targeted PASS를 전체 matrix·actual provider·release-ready로 확대하지 않는다. 실제 최소 E2E와 공개 models GET은 전체 번역 품질·모든 제공사·최종 청구서 검증을 대신하지 않는다.

## Phase 3 — 진행 중

- [x] COMP-01 SNBT 명령 텍스트(합성 fixture·실제 Gemini 합성 world E2E). 1.21.5+ 실제 생성 맵의 게임 로드는 COMP-04.

- [ ] datapack visible text / command storage / scoreboard 조사, opt-in 지원과 detected/unsupported/preserved coverage.
- [ ] external folder pack/fill/merge, collision·path 안전성. ZIP/source·target locale/overwrite·skip는 Phase2 구현, native gate PASS.
- [ ] occurrence별 include/exclude와 전체 위치 lazy query.
- [ ] scan/override/checkpoint/resume schema migration의 일반 계약·rollback. 기존 `EXTRACTOR_VERSION` 3으로 이전 scan을 무효화하는 경로는 구현됐으며 전체 migration 완료는 아님.
- [ ] candidate/occurrence/glossary/TM/job history SQLite 범위·indexes·migration/rollback.
- [x] world/global glossary와 규칙·import/export/delete(2026-10-04). revision 이력은 미구현.
- [ ] revision/context-aware TM, world 격리, 잘못된 번역 무효화·편집·삭제.
- [ ] provider 가격·시각 기반 token/cost low/high 추정과 실제 usage 비교, resume 남은 분량. 2026-10-02 실제 DeepSeek 1요청/3후보 번역·write/restore와 catalog 모델 변경 후 자동 재계산은 확인했지만, 실제 $0.000219114가 예상 상한 $0.00010710을 초과했다. reasoning 토큰·실제 라우팅 단가를 반영한 추정 보강 필요. [검증 기록](history/deepseek-api-verification-2026-10-02.md)
- [ ] COMP-02–06: 최신 component·chunk별 DataVersion/coverage·대표 게임 버전 생성/로드·혼합 형식·구형 pack·버전별 지원 근거. 기존 압축/entities/dimensions/emoji/NUL 및 신규 .mcc 합성 회귀를 재구현하는 작업은 아님.
- [ ] crash/kill 뒤 interrupted 복구, consistency 검사, 사용자 restore/resume/discard.
- [ ] 자연스러운 core/desktop 모듈 분리, CLI·legacy 설정 호환.
- [x] 공개 settings import/export/reset, 전체 앱 두 단계 초기화(백업 유지·키 삭제 선택), 데이터 위치 표시, 도움말/시작 안내, 데스크톱 밀도와 시스템/라이트/다크 모드 구현. Linux 검증 기록이며 최신 macOS native gate는 UX-NATIVE-01.
- [ ] screen reader/high contrast(원문 `lang` U20 포함), 사용자 font size/density 설정, diagnostics redaction 범위 점검, cache/TM 개별 삭제. 고정된 13px 밀도 구현은 사용자 조절 기능의 완료가 아님.
- [x] About의 앱 버전 조회와 앱 안 third-party license 뷰어·고지 생성기.
- [ ] About에 실제 build commit·target별 SBOM 연결, 배포물의 license/NOTICE 완전성·MPL source 안내 확인(LEGAL-01). 현재 버전 표시가 build commit 증거를 대신하지 않음.
- [ ] macOS Apple Silicon/Windows x64/Linux x64 clean-machine; macOS Intel 목표 유지 시 별도.
- [ ] installer sidecar/dependencies/assets/data/chooser/credential/restart/update 확인.
- [ ] 실제 credential이 있을 때 signing/notarization/updater verification·rollback.
- [ ] docs/support matrix를 실제 근거와 일치시킨 뒤 Phase 3 commit → push.

## 실행·비용·배포 경계

원본 sample 쓰기 금지. 합성 또는 복사본에서 SHA-256 baseline을 기록하고 쓰기·복원 전후를 비교한다. 추가 실제 API 비용은 이번 제공사 응답 기준 $0.0001484다. 실제 E2E의 기존 허용 예산은 추가 총 $1 이하(목표 $0.01–$0.10)이며 mock 먼저·최소 호출 원칙을 따른다. 최소 E2E는 완료했고 같은 입력의 유료 호출을 반복하지 않는다.

[CI 정책](ci-policy.md)에 따라 일반 문서/UI 변경은 Python CI를 시작하지 않으며 installer는 manual/tag이다. 이전 진행 저장은 `[skip ci]` checkpoint였다. 이번 main 통합의 Python/CI 변경은 자동 core 검사의 대상이며 installer/release dispatch는 하지 않는다. 공개 release·서명 자격·사용자 world upload는 별도 확인 없이 하지 않는다.

맵 재배포·상표·의존성 권리는 [면책 안내](disclaimer.md)와 [라이선스 검토](legal/license-review.md)를 따른다. 미검증을 완료라고 쓰지 않고 충돌을 발견하면 기록·해결한 뒤 해당 배포를 재개한다.
