# 현재 상태 — 2026-10-04

## 판정

**Phase2 데스크톱 기능·macOS arm64 개발 환경 gate 완료 / Phase3 진행 중(COMP-01 완료) / release-ready 아님.** 2026-10-01 후속 작업으로 [네이티브 UX·Gemini·SNBT 개선](history/native-ux-and-compat-2026-10-01.md)을 구현했다. 이 후속 변경의 macOS native 확인은 아직 하지 않았다(Linux에서 Rust 컴파일·테스트와 browser fixture로만 확인). `claude/review-and-plan-2026-10-01`의 7개 commit을 2026-10-02 main에 fast-forward 통합했다. [통합·대조 기록](history/main-integration-2026-10-02.md). 최신 SHA/원격 상태는 Git 기록을 따른다. 플랫폼·서명 배포 gate는 남아 있다.

최신 증거는 [Phase2 완료 검증](history/phase2-completion-2026-10-01.md), 샘플 provenance·실제 provider는 [샘플·시작 복구 검증](history/sample-startup-validation-2026-10-01.md), 설정 증거는 [설정·추론 UI/UX 개선](history/settings-ux-2026-10-01.md), 전체 backlog는 [남은 작업](follow-up-work.md)이다. 과거 중단 기록은 현재 실행 상태를 덮어쓰지 않는다.

## 구현한 제품

2026-10-02 후속: [실제 DeepSeek 검증](history/deepseek-api-verification-2026-10-02.md)에서 최신 Python JSONL/core의 3후보/1요청 번역·write/reopen·hash 일치 복원, API catalog 기반 모델 변경·비용 재계산을 확인했다. 비용 추정 상한 초과는 미완으로 남겼다. 최신 native 검증은 아니다. 통합된 작업 브랜치를 삭제해 로컬·원격 heads는 main만 남겼다.

- Tauri 2 / Rust shell / Svelte 5 / TypeScript / Vite, 패키지된 Python JSONL sidecar. 기존 CLI와 같은 코어를 사용하며 desktop은 localhost 서버를 열지 않는다.
- 시작 hello30초/bootstrap60초 절대 deadline, 오류 안내·재시도·소유 sidecar 정리. 무응답30/60초 후 실제 앱 retry와 cold Ready 확인; hello 이후 긴 번역/복원 작업에는 일괄 timeout을 적용하지 않는다.
- World → Scan → Review → Run → Result, Backups / Settings / About 분리와 공통 shell·dialog·toasts.
- 데스크톱 셸(후속): 고정 사이드바·툴바와 내용만 스크롤, 13px/30px 데스크톱 밀도, macOS overlay 타이틀바, 메뉴(월드 열기 ⌘/Ctrl+O, 설정 ⌘,, 찾기 ⌘/Ctrl+F), 월드 폴더 드래그&드롭, 런처 saves 월드 목록(`worlds.discover`, 읽기 전용), Dock/작업 표시줄 진행률, 작업 중 ⌘Q 종료 보호, 창 제목·테마 동기화. macOS native 미확인.
- 고유 후보·발생 횟수·종류·좌표/청크, 검색·종류/포함/제외/직접 번역 필터·정렬·서버 paging·bulk·virtual table. 100k fixture에서 DOM과 페이지 캐시가 제한됨을 브라우저로 검증했다. 실제 100k 월드 전체 처리 성능은 별도다.
- model/provider/성능 변경은 scan 유지; 번역 범위/대상 언어 변경은 invalidation. 결과 상태·진행 event는 사용자 문구로 표시한다.
- 재개 요청의 최신 후보 제외·직접 번역을 우선 적용하며, 이전 클라이언트가 생략한 필드만 checkpoint로 보충한다. Native 회귀에서 변경 파일1/요청0/최신 번역문을 확인하고 대상4파일 byte-identical 복원했다.
- Collect → Translate → Write, provider fail-fast/circuit breaker, checkpoint·retry·cancel, 사용량·실패·경고 보고. 취소 뒤 늦게 도착한 응답 사용량도 최종 보고에 합산한다.
- NBT 원본 바이트 보존, Java modified UTF-8(NUL/CESU-8 emoji), nested component·extra/with/fallback/hover/click/container/text_display/command text 추출.
- 명령 텍스트: JSON과 Java 1.21.5+ SNBT(`mwt/snbt.py`, 바뀐 문자열만 원래 따옴표로 재기록), 선행 `/` 명령과 문자열 컴포넌트. 해석 불가 명령은 원본 유지 + `command_unparsed` 경고. `EXTRACTOR_VERSION` 3. 서식 토큰은 개수 완전 일치·추가 금지로 검증.
- 앱 데이터의 검증된 백업, legacy `.pomi-backups` 발견/복원, 복원 직전 recovery snapshot.
- 번역 후 처음 생성된 `.mcc`의 원래 부재를 백업하고 복원 직전 payload를 recovery에 보존한다. payload→region 순 write/restore, 물리 `.mcc` 변경 파일 집계와 255-sector 경계·중간 write 실패 fixture/native 검증.
- 기본 credential은 Rust SQLite/AES-256-GCM + 별도 설치별 key 파일. Session과 opt-in OS keychain; 자동 keychain 읽기/import 없음. 저장된 키 전체는 UI에 반환하지 않는다. Local→Session 전환 시 stale local ciphertext 제거를 atomic metadata transaction으로 처리한다.
- 같은 계정으로 DB와 key 파일을 모두 읽는 프로세스까지 막는 설계는 아니다. Windows permission 코드는 target typecheck만 통과했으며 native 검증 전이다.
- OpenAI/Gemini/Anthropic/OpenRouter/Comet/Custom, provider endpoint 고정과 Custom wire format·URL 검증. Gemini는 헤더 인증, thinking 제어(3.x level/2.5 budget), 사고 토큰 사용량 합산, MAX_TOKENS 실패 처리. CLI 환경변수 호환과 Rust-owned sidecar 환경변수 차단을 구분한다.
- 설정 그룹/disclosure, 종류별 scope 및 curated presets, 파일/key 규칙, global source overrides, performance/file retry/error 정책, 공개 JSON import/export/reset, literal `translate.py` 읽기 전용 preview, 명시적 확인 후 style helper.
- System/Light/Dark 즉시 적용·설정 파일 저장·보기 메뉴 동기화·OS 변경 추적·시작 전 배경 적용, ko/en/ja semantic i18n. 중국어 간체 UI는 2026-10-04부터 제공한다. 최신 macOS/Windows 창 확인은 남아 있다.
- 도움말 화면·F1/⌘? 메뉴·첫 실행 Tour, 허용 목록 외부 링크·데이터 폴더 열기, About 앱 버전·license 뷰어. 공개 설정 import/export/reset과 전체 앱 두 단계 초기화(백업 유지, 저장된 키 삭제 선택).
- 설정 파일 fsync·atomic replace·동일 내용 사본·손상본 보존/복구, app_prefs 테마·안내 동의 저장. 모델 catalog는 atomic write를 사용하며 설정과 같은 사본 복구는 구현하지 않았다.
- updater 확인·자동 알림·작업 잠금·서명 검증 설치/재시작 경로 연결. 공개키는 비어 있고 signed release/latest.json 게시와 실제 업데이트 검증은 RELEASE-01에 남아 있다.
- native View 메뉴의 75–200% 실제 WebView 확대. Cmd/Ctrl+0은 100%, Cmd/Ctrl+2는 200%. Dialog는 명시적 fixed 위치·동적 viewport 높이를 사용하고, native에서 보이지 않던 등장 애니메이션을 제거했다.
- alternate app identifier는 명시적인 sidecar data root로 격리한다. 테스트 설정·DB·키·월드가 production root로 흘러가지 않는다.
- 선택한 월드 밖으로 연결된 level/region/entity/resource pack은 읽기·API 전에 차단한다. resources.zip symlink는 내부 대상이어도 restore 경로 보존을 위해 차단한다. 큰 파일 지문/백업 해시는 스트리밍한다.

2026-10-04 상용 수준 UX 개편: 적용 전 번역 검토(기본값)·행별 수정·실패한 문장만 다시 번역·적용 뒤 번역문 수정(작업 백업 복원 후 캐시 재적용, 중단 시 복구 snapshot·`reapply_interrupted`), 실패 이유 코드화, 비용 한도(`max_cost_usd`)·추론/용어집 여유를 포함한 추정·사용자 입력 단가, 전역·월드별 용어집(프롬프트 주입·불일치 1회 재요청·변경 시 적용 차단), 첫 실행 설정 도우미(저장하지 않은 키로 연결 확인·추천 모델·도착 언어 목록), 설정 탭(번역/스캔 범위/고급/앱)·표/칩 편집기, 진행 남은 시간·최근 번역·OS 완료 알림, 창 닫기/⌘Q 저장 확인(설정·도우미·용어집·검토 수정본)·작업 중 종료 보호 재확인, 창 크기·위치 복원, Rust 오류 코드화, 재방문 요약·백업 행 압축·후보 위치/`/tp` 복사·우클릭 메뉴·되돌리기, 중국어 간체 UI. 최종 gate check 0/0·frontend108·Python 전체·Rust63·browser260 PASS(macOS arm64 browser fixture). native 창·OS 알림·실제 제공사·설치본은 확인하지 않았다. 서명·공증·updater 키는 사용자 결정으로 제외. [기록](history/ux-overhaul-2026-10-04.md) · 남은 문제: [알려진 UI/UX 문제](ux-issues.md)

2026-10-02 UI/UX 실사용 점검: 설정 이탈 시 저장 확인, 새 설치 설정 안내·돌아가기, 좁은 창 키보드 검토, toast 위치, 표시 언어 즉시 적용, 복원 확인 정리, 후속으로 시작 실패 시 도움말·정보 접근, 복원 후 다시 스캔 안내, 작업 영역 폭 기준 후보 상세 패널, 낮은 창의 검토 다음 단계 버튼 고정, 처음부터 다시 번역(비용 확인), 결과 화면 다음 행동·실패 목록 개수 안내 등. UI-only이며 Phase 상태는 바뀌지 않는다. [기록](history/ux-audit-2026-10-02.md) · 남은 문제: [알려진 UI/UX 문제](ux-issues.md)

## 문서·라이선스 정리

2026-10-02 현지화 후속: 영어·한국어·일본어·중국어 간체 README/사용 안내/개인정보/면책을 같은 진입점으로 연결했다. 문자 에셋은 4개 언어의 공유4+안내16을 공통 catalog/SVG/PNG로 관리하며, 현재 UI 언어 ko/en/ja의 소개 화면9장을 합성 데이터로 다시 캡처했다. 당시 중국어는 문서만 제공했고, 2026-10-04 중국어 UI와 중국어 소개 화면을 더했다. 타입 검사0오류/0경고·i18n3 PASS·문서 링크/이미지 hash/시각 검토는 이 범위의 결과이며 Phase3·native·release 완료 검증이 아니다. [문구·에셋 관리](localization.md) · [작업 기록](history/localization-2026-10-02.md)

서비스 소개와 사용법은 root README(영어 메인)와 [한국어판](README.ko.md), 자세한 실행·복원은 user-guide, 비용·키 저장은 privacy, 개인 프로젝트/보증·책임 제한은 disclaimer로 구분했다. 기여자는 김현민(mini0227kim@gmail.com)이다. 기존 MIT를 유지하고 제3자 metadata 검토·미확인 플랫폼/배포 고지를 legal 문서와 LEGAL-01에 기록했다. 날짜별 기록은 history, 의도적인 합성 소개 화면은 images에서 관리한다. 2026-10-01 다국어 README(ko/en/ja/zh)를 같은 범위로 맞추고 user-guide에 설정·결과·CLI·문제 해결을 보강했고, 2026-10-02 메인 README를 영어로 전환하고 한국어판을 docs/README.ko.md로 옮기며 개인 프로젝트 배경 안내를 기여자 절로 이동했다. [2026-10-01 기록](history/docs-refresh-2026-10-01.md) · [2026-10-02 기록](history/readme-restructure-2026-10-02.md) 이번 문서 작업으로 유료 API·전체 matrix·installer 빌드를 실행하지 않았다.

## 검증 기록과 적용 범위

아래 PASS 수치는 브랜치의 기존 기록이다. 이번 통합에서는 코드·문서·Git 이력을 대조했으며 테스트/빌드/native/API를 새로 실행하지 않았다. Phase2 행은 `c26fcd7` 이전 범위의 이력이고 후속 UI/Rust/provider source의 최신 native PASS가 아니다.

| 영역 | 기록된 증거 | 범위 |
| --- | --- | --- |
| 후속(2026-10-02) | Python23/Rust30/check·build/frontend62/browser114 PASS: 도움말·시작 안내·라이선스 뷰어·업데이트·데이터 위치·초기화·설정 내구성, 라이트/다크/시스템 화면 모드(설정 타일·보기 메뉴·OS 변경 추적·시작 전 적용·전 화면 다크 axe) | [업데이트·데이터](updates-and-data.md). 실제 서명 release 업데이트·각 OS native 미확인 |
| 후속(2026-10-01) | Python22/Rust28/check·build/frontend58/browser98 PASS(부드러움·일관성 후속 포함), 실제 Gemini 실측 | [네이티브 UX·Gemini·SNBT](history/native-ux-and-compat-2026-10-01.md). Linux 환경, macOS native 미확인 |
| Python | 최종20 suites PASS | 신규 .mcc 경계/복원/실패/물리 집계 및 기존 core/provider/JSONL |
| Frontend | 전체11 files /58 PASS | startup4 포함 Phase2 당시 frontend source |
| Browser | 최종87 실행 중86 PASS/1 FAIL→수정 후 영향7 PASS | override 입력창 자동 닫힘과 오래된 Save 기대 수정. 영향 없는86 재사용; 단일 전체87 PASS 실행 아님 |
| Type/build | 0 errors /0 warnings, production build PASS | Phase2 당시 UI source |
| Rust | 28 PASS | 기존 vault/routing 및 신규 startup deadline4 |
| Packaging | sidecar + unsigned debug Eval app PASS (59.21 MiB) | Phase2 당시 macOS arm64, shared cache; clean-machine 검증 아님 |
| Native | startup fault2종/retry/cold Ready, 실제 API 및 신규 .mcc 수동 번역·복원 PASS | Phase2 패키지 변경2/API0/원래2파일 hash 차이0·새 .mcc 없음, 이전 world4+ZIP1도 차이0 |
| Real API | OpenRouter 최소 E2E PASS, provider 비용 $0.0001484 | 3문장/1요청, 입력391/출력108, 누적 usage 전후·verified backup/native restore |
| 실제 샘플 | 총9435청크 읽기/NBT 바이트 보존 PASS | 공개5 region 후보0; Roguefire 복사본477후보·12쓰기·전체117파일 hash 복원0, 게임 로드 NOT_RUN |

Phase2 당시 패키지 hash·native는 Phase2 완료 기록을, 실제 API·샘플 provenance는 샘플·시작 복구 기록을 따른다. 설정 화면의 이전 정확한 범위는 UI/UX 문서를 따른다. source/dependencies가 같은 Rust28 등은 유효 범위로 재사용했다. 기존 native 200% 확대는 이전 범위별 증거이며 전체 release gate PASS로 복사하지 않는다.

## 지원 경계와 남은 gate

스캔은 각 차원의 `region`/`entities`, 선택 시 월드 안의 일반 파일 `resources.zip`과 명시적으로 선택한 외부 ZIP이다. datapack, command storage, scoreboard, playerdata, level.dat visible text, folder pack/merge는 아직 스캔·번역 지원하지 않는다. 명시 선택 외부 ZIP은 구현 및 Python/browser 검증을 마쳤으며 native 번역/백업/복원 후 기준5파일 hash 차이0을 확인했다. [fixture 지원 표](support-matrix.md)의 supported는 해당 합성 형식을 통과했다는 뜻이며 모든 Java 버전/모든 실제 월드 지원은 아니다.

Legacy UI/launcher는 유지한다. [기능 비교](legacy-ui-parity.md)에 항상 백업·앱 관리 backup/checkpoint·공개 설정 literal import의 대체 범위를 확정해 명시했다. off/suffix/임의 경로와 동등 기능이나 100% parity 완료를 주장하지 않는다.

최소 실제 provider/usage/cost/restore와 개발 환경의 Phase2 gate는 완료·commit/push됐고 Phase3 COMP-01 및 후속 UX 구현을 main에 통합했다. Phase3 잔여 호환성·품질·데이터/복구, 후속 macOS native, Windows/Linux clean-machine, signing/notarization·실제 updater 설치/release는 남아 있다. [CI 정책](ci-policy.md)은 main의 관련 Python 변경/PR만 자동 core 검사, installer manual/tag, 수동 기본 Linux다. installer/release dispatch는 하지 않는다.

## 저장소 주소

GitHub push 응답의 이동 안내와 기존/새 주소의 동일 main SHA로 `kim0040/PomiTranslate`를 확인했다. 소개/clone/문의 링크와 origin을 새 주소로 맞췄다. 로컬 `reference/Minecraft-World-Translator` 및 mwt 경로는 유지한다.
