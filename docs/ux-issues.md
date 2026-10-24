# 알려진 UI/UX 문제 — 2026-10-24

2026-10-02 실사용 점검([기록](history/ux-audit-2026-10-02.md))에서 남긴 U1–U19와 2026-10-03 상용 수준 평가에서 찾은 문제는 2026-10-04 UX 개편([기록](history/ux-overhaul-2026-10-04.md))에서 고쳤다. 백로그 ID는 [추후 작업](follow-up-work.md)의 **UX-WEB-01**이며, 새로 찾은 문제는 이 표에 더하고 고치면 지운 뒤 날짜별 history에 남긴다.

2026-10-23 상용 수준 점검([기록](history/commercial-readiness-2026-10-23.md))에서 U1(창 닫기 때 미저장 설정: 종료 의도 경로의 저장/버리기/취소), U15(코어 종료를 `CORE_STOPPED` 코드로), U16(실패 이유를 코드로 분류해 문구로 표시), U20(용어집 내보내기 저장 창)을 고쳐 지웠다. U1의 실제 창(X·Alt+F4·⌘Q) 확인은 UX-NATIVE-01에 남는다.

같은 날 설정 화면 점검([기록](history/settings-parts-2026-10-23.md))에서 U2(키 저장 직후 모델 목록 자동 조회)·U5(환경 설정을 "번역"/"앱" 두 부분으로 분리)·U12(선택지가 있는 dialog의 중복 X 제거)를 고쳐 지웠다. 같은 날 U19도 고쳤다: CometAPI 공식 키 가이드·quickstart가 가리키는 `https://www.cometapi.com/console/token`을 도움말 키 발급 목록에 넣었다. U18(좁은 폭 단계 표시)은 현재 코드에서 이미 "n/5단계 · 이름"으로 해결돼 있어 지웠다. 이 화면들의 실제 창(native) 확인은 UX-NATIVE-01에 남는다.

문서·화면 자료 점검([기록](history/docs-recapture-2026-10-23.md))에서 U13(ko/en/ja 소개 화면과 manifest를 현재 UI로 다시 캡처)과 U14(4개 언어 사용 안내에 즉시 적용·저장 확인·처음 설정과 돌아가기·진단 파일 저장 설명)를 고쳐 지웠다.

흐름·결과 화면 점검에서 U17(실패 뒤 이어서 할 기록이 없으면 "같은 스캔으로 다시 번역"을 첫 행동으로), U7(재방문 시 월드 요약·이어서 할 작업), U8(백업 목록을 한 카드의 두 줄 행으로), U9(결과 숫자 이름을 "적용됨/일부 적용/준비만 됨"으로), U11(사이드바·진행 화면 공용 시계, 충분히 진행된 뒤에만 남은 시간 추정)을 고쳐 지웠다. U10(정보 화면 머리 표시)은 이미 해결돼 있었다. 모두 browser fixture로 확인했으며 실제 제공사 실패에서 어느 상태가 나오는지는 확인하지 않았다.

용어집 화면 성능 점검에서 U21(2,000개 목록)을 고쳐 지웠다: 저장 안 됨·개수·검색 일치를 편집한 줄만 다시 계산하고 200개를 넘으면 화면 밖 줄에 `content-visibility: auto`를 써서, Chrome 4배 CPU 제한·합성 2,000개(browser fixture)에서 입력 한 번이 렌더될 때까지 200개 표시 약 140 → 38 ms, 2,000개 표시 약 330 → 47 ms, "더 보기" 한 번 약 970 → 430 ms로 줄었다(native·실제 데이터는 확인하지 않았다).

심각도: **높음** = 작업을 잃거나 막힘 · **중간** = 헷갈리거나 돌아가야 함 · **낮음** = 다듬기.

## 남은 화면 문제

2026-10-24 병합(`improve/commercial-readiness`에 main의 UX 개편과 2026-10-11 리뷰 수정 WIP를 합침)으로 두 갈래에서 따로 고친 U1–U19·U21 계열 문제와 2026-10-11 리뷰의 UI 항목(비용 한도 기본값·오류 표시·i18n 동적 키·단계 이름과 설정 과밀·큰 컴포넌트 분리·aria-live와 글자 크기)이 한 코드에 들어왔다. 아래 두 표의 항목은 병합 전 각 갈래의 화면에서 찾은 것이며, 병합된 화면에서 다시 확인하기 전에는 "고쳤다"고 쓰지 않는다. 병합된 소스의 검증 결과는 [현재 상태](current-state.md)를 따른다.

## 화면 구성

| # | 심각도 | 문제 | 위치 | 제안 |
| --- | --- | --- | --- | --- |
| U22 | 낮음 | 용어집 화면·가져오기·"용어집에 추가"·품질 경고는 browser fixture(mock core)로만 확인했다. 실제 core의 glossary 응답, native 저장 창에서의 용어집 파일 저장(`glossary_csv`)과 저장 실패 시 클립보드 복사, 스크린 리더 읽기는 확인하지 않았다. | `tests/browser/glossary.spec.ts` | UX-NATIVE-01·QUALITY-01 native 점검에서 함께 확인 |
| U23 | 낮음 | 용어집을 "더 보기"로 200개 넘게 펼치면 화면 밖 줄은 `content-visibility: auto`로 그리기를 미룬다. Chrome에서 이 줄들은 목록 항목으로는 남지만 안의 입력란이 접근성 트리에 스크롤해 가까워질 때까지 나타나지 않아, 화면 읽기 프로그램의 탐색 모드(NVDA/JAWS)에서 먼 줄이 비어 보일 수 있다. Tab·포커스는 모든 줄에 닿는다. 200개 이하 목록은 영향 없음. 실제 화면 읽기 프로그램으로 확인하지 않았다. | `GlossaryScreen.svelte` `.entries.long .entry` | 실제 화면 읽기 프로그램 확인 후 문제가 되면 검색 안내를 두거나 접근 가능한 가상 목록으로 교체 |
| U24 | 낮음 | 번역 결과 검토의 원문 칸은 원문 언어를 알 수 없어 `lang`을 지정하지 않는다. 화면 읽기 프로그램이 일본어·한국어 원문을 UI 언어 발음으로 읽을 수 있다. (2026-10-04 개편 목록에서는 U20이었으나, 같은 번호를 용어집 내보내기 저장 창 항목이 이미 썼으므로 U24로 옮겼다.) | `TranslationTable.svelte`, `TranslationDetail.svelte` | 스캔 단계에서 원문 언어를 안정적으로 판별할 수 있게 되면 그 값만 `lang`으로 지정. 화면 읽기 프로그램 수동 점검(Phase3 접근성)과 함께 |

## 검증 공백 (기능은 구현됨, 확인 안 함)

아래는 browser fixture(합성 데이터)와 단위 테스트, 또는 병합 이전 소스의 자동 검사로만 확인했거나 아직 확인하지 않았다. 코드상 구현은 끝났지만 실제 창·OS·제공사에서 동작을 본 적이 없다. UX-NATIVE-01에서 함께 본다.

- **병합된 UI의 browser·접근성 검사:** 2026-10-11 ui-ux WIP는 마지막 편집 뒤 browser spec을 돌리지 않았고 설정 탭 spec이 깨질 것으로 예상했다(`settings-tabs`, `settings-ux`, `workflow`, `setup-wizard`, `help-and-maintenance`, `manual-translations`, `review-apply`, `locale-zh`, `ux-flow`). 단계 이름 치환, 비용 한도 "가격 모름" 확인 흐름(`COST_CAP_UNPRICED`, 한도 적용 없이 시작), 글자 크기 100/115/130%, 다크 모드, 320px 폭, axe(aria-live가 단계만 알리는지)는 병합된 소스에서 확인해야 한다.
- **번역 문구:** 새 오류 코드 3개(`REQUEST_TOO_LARGE`, `CUSTOM_KEY_ORIGIN_MISMATCH`, `CUSTOM_ENDPOINT_INSECURE`)와 `COST_CAP_UNPRICED`의 ko/en/ja/zh 문구, ja/zh 용어와 영어 전체 문구의 점검.
- **소개 화면:** `docs/images/locales/*` 12장은 출처가 둘로 갈린다(ko/en/ja는 병합 전 commercial-readiness UI, zh는 병합 전 main UI). 병합된 UI가 안정되면 [현지화 관리](localization.md)의 절차로 모두 다시 캡처한다.
- macOS/Windows 실제 창: 창 X·⌘Q 시 저장하지 않은 설정·설정 도우미 입력·번역 검토 수정본 확인 dialog, 작업 중 종료 보호의 마지막 경계, 10초 무응답 fallback. (Windows의 설정 닫기 확인은 2026-10-23에 UI Automation으로 확인했지만 병합된 소스에서는 다시 보지 않았다.)
- OS 알림: 첫 알림 때만 권한 요청, 허용/거부, 실제 전달, 창이 앞에 있을 때와 설정을 끈 때 억제.
- 창 크기·위치·최대화 복원, 모니터 제거·배율 변경, 전체 화면에서 일반 크기를 덮어쓰지 않는지.
- 실제 제공사: 설정 도우미의 연결 확인(저장하지 않은 키로 모델 목록 조회), 용어집 프롬프트·불일치 재요청의 실제 비용, 비용 한도 정지 시점, 실패 코드 분류(시간 초과·인증·한도 등)의 실제 응답 대응.
- 위 목록과 2026-10-02 수정은 Linux browser fixture로만 확인했다. macOS overlay 타이틀바·Windows 창에서 toast 위치, 저장 확인 dialog, 사이드바 "작업 화면 보기"를 UX-NATIVE-01에서 함께 본다.
- 화면 읽기 프로그램·고대비는 이번 점검 범위가 아니다(Phase3 접근성 항목). 글자 크기 조절(100/115/130%)은 구현됐으나 확인 전이다.
- Linux에서 Rust lib 테스트(`cargo test --manifest-path src-tauri/Cargo.toml --lib`)는 GTK/WebKit 개발 패키지 외에 sidecar 바이너리(`src-tauri/binaries/pomi-sidecar-<target>`)가 있어야 build script를 통과한다. Rust를 바꾸는 작업은 `pnpm sidecar:build` 후 실행하거나 native 환경에서 확인한다.

## 이전 메모

U3·U4·U6은 2026-10-02 후속 작업에서 고쳤다([기록](history/ux-audit-2026-10-02.md#후속-수정--u3u4u6)). U1은 2026-10-23에 구현했다(native 확인은 남음).
