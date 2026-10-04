# PomiTranslate 제품 저장소 에이전트 지침

작업 시작 시 다음을 읽는다:

1. 사용자 최신 요청과 상위 AGENTS.md.
2. `docs/verification-policy.md` — 검증 선택·증거 재사용·중단 규칙.
3. `docs/history/main-integration-2026-10-02.md`, `docs/current-state.md`, `docs/follow-up-work.md` (이전 중단 이력: `docs/history/phase2-pause-2026-10-01.md`).
4. `docs/PomiTranslate_Implementation_Plan_and_Agent_Instructions_v1.1.md`.

## 실행 계약

- 기존 Python/Tauri/Rust/Svelte 구조와 WIP를 보존한다. reset/clean/checkout으로 미완 작업을 없애지 않는다.
- 일반 수정은 affected tests만. 전체 viewport/axe/100k/screenshot/Python/Rust/package/API 반복은 최종 gate 또는 구체적인 남은 위험일 때만.
- `pnpm verify:plan`은 실행 없는 계획 확인. 소스 안정화→관련 검사→필요하면 마지막 전체 gate 순서. 같은 source의 유효 PASS를 재사용한다. 테스트 실행 중 source 수정 금지.
- UI-only는 browser/dev, Python 변경은 관련 fixture부터. 매 UI 수정에 sidecar clean/Tauri/installer build 금지. Native 최종 gate를 fixture PASS로 대체하지 않는다.
- 중단 요청 시 새 테스트/빌드/서버/유료 호출 금지. 소유 확인한 프로젝트 프로세스만 종료하고 인계를 갱신한다.
- Local encrypted DB+설치별 key 파일이 credential 기본, Session/OS keychain opt-in. keychain 자동 접근/import 없음. 평문 키는 화면/로그/채팅/파일/Git에 남기지 않는다.
- world write/restore는 합성/복사본에서 baseline SHA-256으로 비교한다. 원본 sample 쓰기 금지. 알 수 없는 결과를 성공으로 보고하지 않는다.
- 구현/자동 검사/native/실제 provider/release를 구분한다. Phase2 완료 전 Phase3 구현 시작 금지.
- 사용자 중간 저장 요청에 따른 checkpoint commit은 허용하지만 Phase complete라고 부르지 않는다. Phase 완료 commit은 검증→docs/diff review→commit→push 순서다.
- CI는 관련 main Python만 자동, installer manual/tag. 사용자 중단·중간 저장 push는 `[skip ci]`로 불필요 실행을 막는다. 공개 release/signing/upload는 기존 승인 경계를 따른다.

## 현재 재개 상태

2026-10-02 main 통합: Phase2 개발 환경 gate 완료 / Phase3 진행 중(COMP-01 완료) / release-ready 아님. 원격 `claude/review-and-plan-2026-10-01`의 7개 commit을 `c26fcd7`→`e97261c`로 fast-forward했다. SNBT·Gemini·native UX·도움말/Tour·license 뷰어·업데이트 연결·초기화·설정 내구성·화면 모드가 구현됐다. [통합·잔여 대조](docs/history/main-integration-2026-10-02.md), [후속 구현](docs/history/native-ux-and-compat-2026-10-01.md), [업데이트·데이터](docs/updates-and-data.md)를 읽는다.

Linux Python23/Rust30/frontend62/browser114 PASS는 브랜치의 기존 기록이며 이번 통합에서 새로 실행한 결과가 아니다. 후속 변경의 macOS native, clean-machine/각 OS keychain·permission, 게임 버전 표본/로드, signed updater/release·SBOM/최종 license gate는 남아 있다. 빈 updater 공개키·latest.json 게시와 공개 릴리스는 RELEASE-01 승인 경계다. 다음 순서는 [추후 작업](docs/follow-up-work.md)의 UX-NATIVE-01 → PROVIDER-01 → COMP-02/03/04 → QUALITY-01이다.

Phase2 이력은 `docs/history/phase2-completion-2026-10-01.md`와 `docs/history/sample-startup-validation-2026-10-01.md`를 따른다. Python20/frontend58/Rust28·native .mcc hash 복원·OpenRouter 최소 E2E는 당시 범위이며 후속 source의 native 증거로 복사하지 않는다. Desktop 항상 백업·앱 관리 backup/checkpoint, Legacy 유지, schema2 호환/schema3 부재 marker 복원을 유지한다.

2026-10-04 상용 수준 UX 개편을 main에 통합했다: 적용 전 번역 검토·수정 재적용·실패만 재시도·비용 한도·용어집·설정 도우미·설정 탭·닫기 보호·OS 완료 알림·창 복원·중국어 간체 UI. browser fixture·Python·Rust·browser260 PASS이며 native 창·알림·실제 제공사·서명은 확인하지 않았다. UI 언어는 이제 ko/en/ja/zh다. [기록](docs/history/ux-overhaul-2026-10-04.md)

## 문서 정리 후 진입점

사용자 문서: README.md(영어 메인) / docs/README.ko.md(한국어) / docs/user-guide.md / docs/privacy.md / docs/disclaimer.md. 작업 상태: docs/current-state.md / docs/follow-up-work.md. 이력: docs/history/. 라이선스: THIRD_PARTY_NOTICES.md / docs/legal/. 소개용 합성 screenshot은 docs/images/에서 의도적으로 추적하며 일반 output·report·world·DB·key는 제외한다. 과거 진행 저장은 checkpoint이며 최신 Phase2 완료 판정은 완료 기록을 따른다.

2026-10-01 다국어 README(ko/en/ja/zh)와 user-guide를 보강했다. 제품 동작·Phase 상태는 바뀌지 않았다. [기록](docs/history/docs-refresh-2026-10-01.md)

2026-10-02 메인 README를 영어로 전환하고 한국어판을 docs/README.ko.md로 옮겼다. 개인 프로젝트 배경 안내는 기여자 절에서 다룬다. 제품 동작·Phase 상태는 바뀌지 않았다. [기록](docs/history/readme-restructure-2026-10-02.md)

원격 URL은 2026-10-01 기존/새 주소의 동일 main SHA를 확인한 `https://github.com/kim0040/PomiTranslate.git`다. 원격 rename을 새로 실행한 것이 아니다. 로컬 checkout 폴더와 내부 mwt 이름은 유지한다.

2026-10-02 현지화: README/사용 안내/개인정보/면책은 ko/en/ja/zh 문서를 제공한다. (2026-10-04부터 zh UI도 제공한다.) [현지화 관리](docs/localization.md)의 catalog·SVG/PNG 생성·언어별 screenshot/manifest를 함께 갱신한다. 제품명·공식 부제·license 원문은 공통으로 보존한다. [작업 기록](docs/history/localization-2026-10-02.md)
