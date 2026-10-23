# 알려진 UI/UX 문제 — 2026-10-02

2026-10-02 실사용 점검([기록](history/ux-audit-2026-10-02.md))에서 찾았지만 **아직 고치지 않은** 문제 목록이다. 같은 날 후속 작업에서 U3·U4·U6을 고쳐 목록에서 지웠고, 이어진 화면 점검에서 찾은 문제 중 화면만으로 고칠 수 있는 것을 고치고 나머지를 U16–U19로 더했다. 이미 고친 항목(설정 이탈 시 저장 확인, 새 설치 설정 안내·돌아가기, 좁은 창 키보드 모달, toast 위치, 표시 언어 즉시 적용, 복원 확인 정리 등)은 기록 문서를 따른다. 백로그 ID는 [추후 작업](follow-up-work.md)의 **UX-WEB-01**이며, 항목을 고치면 이 표에서 지우고 날짜별 history에 남긴다.

점검 범위: Linux browser fixture(합성 데이터, 1280×800·1024×680·900×620)에서 새 설치·재방문·스캔→검토→진행→결과·백업 복원·설정·도움말·정보 화면을 직접 조작했다. macOS/Windows native 창과 실제 provider에서는 확인하지 않았으므로, native에서만 생기는 문제는 이 목록에 없을 수 있다(UX-NATIVE-01).

심각도: **높음** = 작업을 잃거나 막힘 · **중간** = 헷갈리거나 돌아가야 함 · **낮음** = 다듬기.

## 흐름·데이터 손실

| # | 심각도 | 문제 | 재현 | 위치 | 제안 |
| --- | --- | --- | --- | --- | --- |
| U1 | 높음 | 저장하지 않은 설정(입력한 API 키 포함)이 있어도 창을 닫으면(⌘Q·창 X) 경고 없이 사라진다. 화면 이동은 이제 확인하지만 창 닫기는 작업 중 보호만 있다. | 설정에서 키 입력 → 창 닫기 | `src-tauri` close-requested 처리, `app.settingsDirty` | 닫기 요청 때 `settingsDirty`면 앱 안 확인 dialog를 띄우고 닫기를 보류. native 확인 필요 |
| U2 | 중간 | OpenAI·Gemini·Anthropic·Comet은 키를 **저장한 뒤에야** 모델 목록을 불러올 수 있다. 새 사용자는 모델 ID를 모른 채 빈 칸 앞에서 멈춘다. 입력한 ID의 오타도 OpenRouter 외에는 실행 전까지 알 수 없다. | 새 설치 → 설정 → 모델 칸 | `SettingsScreen.svelte` `loadModels`, `settings.model.saveKeyFirst` | 키 저장 직후 목록 자동 조회(사용자 동의 문구와 함께), 또는 제공사별 날짜·출처를 단 추천 모델 표시. PROVIDER-01의 가격표 작업과 함께 |
| U15 | 중간 | 코어 프로세스가 결과 없이 끝나면 Rust가 코드 없는 영어 문장("Translation core stopped before it returned a result")을 보내고, 시작 실패 화면은 그 문장을 한국어·일본어 UI에도 그대로 보여 준다. 시간 초과는 코드(`CORE_HANDSHAKE_TIMEOUT` 등)로 번역되지만 이 경우만 빠졌다. | `scenario=startup-stopped` | `src-tauri/src/lib.rs` 코어 종료 분기, `app.describe()` | Rust에서 오류 코드(예: `CORE_STOPPED`)를 보내고 ko/en/ja catalog에 문구 추가. Rust 변경이라 sidecar 준비 후 Rust 테스트로 확인 |
| U16 | 중간 | 결과 화면 실패 목록의 이유가 제공사가 보낸 원문(영어, 최대 300자)이다. 한국어·일본어 UI에서도 "Provider unavailable" 같은 문장이 그대로 보인다. 목록이 최대 20개라는 점은 2026-10-02에 화면에 표시하도록 고쳤다. | `scenario=result-partial` | `mc_world_translator.py` `translation_failures`, `ResultScreen.svelte` | 실패 이유를 코드로 분류(시간 초과·인증·한도·형식 오류 등)해 catalog 문구로 보여 주고 원문은 보고서에만. Python 변경 |
| U17 | 중간 | "실패" 결과에서 이어서 할 기록이 없으면 버튼이 "처음부터 다시 스캔" 하나뿐인데, 안내는 "잠시 후 다시 시도해 주세요"다. fixture에서 본 경우이며 실제 앱에서 실패 뒤 체크포인트가 남는지에 따라 "남은 문장만 이어서 시도"가 나올 수 있다. | `scenario=result-failed` | `ResultScreen.svelte` `resumable`, 코어 체크포인트 | 실제 provider 실패로 체크포인트 유무를 확인하고, 없으면 같은 스캔으로 "다시 번역"(`translate.start`)을 제공 |

## 화면 구성

| # | 심각도 | 문제 | 위치 | 제안 |
| --- | --- | --- | --- | --- |
| U5 | 중간 | 환경 설정이 카드 8개짜리 긴 한 페이지다. 즉시 적용(화면 모드·표시 언어·업데이트 자동 확인·데이터 폴더·초기화)과 저장 필요(제공사·언어·범위·성능) 항목이 섞여 있어, 저장 막대가 어떤 항목에 해당하는지 알기 어렵다. | `SettingsScreen.svelte`, `AppMaintenance.svelte` | "번역"(저장 필요)과 "앱"(즉시 적용) 탭 또는 섹션 바로가기로 분리하고, 저장 막대는 저장이 필요한 탭에만 |
| U7 | 낮음 | 재방문 시 앱이 "월드 스캔" 단계로 열리는데, 월드 이름·스캔 버튼만 있는 거의 빈 화면이다. 마지막 결과나 이어서 할 작업 여부를 보여 주지 않는다. | `app.boot()` `step = 'scan'`, `ScanScreen.svelte` | 마지막 스캔 시각·후보 수·마지막 번역 결과 요약 또는 월드 선택 화면으로 시작 |
| U8 | 낮음 | 백업 관리: 선택한 월드 카드와 바로 아래 목록 제목이 같은 월드 이름·백업 수를 반복한다. 백업 카드 하나가 세 줄 구획이라 백업이 많으면 길다. | `BackupsScreen.svelte` | 월드 카드를 목록 머리로 합치고 카드를 한두 줄 행으로 압축 |
| U9 | 낮음 | 결과 화면 "일부 번역" 상태의 첫 숫자 이름이 "번역문 준비"라 실제로 파일에 쓰였는지(변경 파일 4개) 헷갈린다. | `ResultScreen.svelte` `result.stat.prepared` | 상태별로 "적용됨/준비만 됨"을 구분하는 문구 |
| U10 | 낮음 | 정보 화면 "스캔 지원 범위" 카드 머리 오른쪽의 "스캔 대상" 표시가 카드 전체의 상태처럼 보인다. | `AboutScreen.svelte` | 머리 표시 제거, 목록 안 구분 표시만 유지 |
| U11 | 낮음 | 번역 진행 중 사이드바 경과 시간과 진행 화면 경과 시간이 1초 정도 다르게 보인다(타이머 주기 1s/0.5s). 남은 시간 추정은 없다. | `Sidebar.svelte`, `RunScreen.svelte` | 공용 시계 하나로 통일, 처리량 기반 남은 시간 표시 검토 |
| U12 | 낮음 | 저장 확인·시작 안내 dialog에 닫기(X)와 "계속 편집"/"건너뛰기"가 함께 있어 같은 동작이 두 번 보인다. | `Dialog.svelte` 사용처 | 선택지가 있는 dialog는 X를 숨기는 옵션 |
| U18 | 낮음 | 최소 창(840px)에서 단계 표시가 현재 단계만 이름을 보이고 나머지는 숫자만 보인다. | `Stepper.svelte` | 숫자에 툴팁·접근 이름은 있으므로, 좁은 폭에서는 현재 단계 이름 + "n/5" 표기 검토 |
| U19 | 낮음 | 도움말 "API 키 발급 페이지"에 지원 제공사인 Comet API가 없다. 공식 키 발급 주소를 코드에서 확인할 수 없어 추측해 넣지 않았다. | `HelpScreen.svelte` `keyPages` | Comet API 공식 키 발급 주소를 확인한 뒤 추가 |
| U21 | 낮음 | 용어집 화면의 항목은 한 번에 200개까지만 그려지고 "더 보기"로 늘린다(2,000개 상한). 가상 스크롤이 아니라 2,000개를 모두 펼치면 낮은 사양 PC에서 느릴 수 있다. native·실제 데이터로 확인하지 않았다. | `GlossaryScreen.svelte` | 느림이 확인되면 가상 목록으로 교체 |
| U22 | 낮음 | 용어집 화면·가져오기·"용어집에 추가"·품질 경고는 browser fixture(mock core)로만 확인했다. 실제 core의 glossary 응답, native 저장 창에서의 용어집 파일 저장(`glossary_csv`)과 저장 실패 시 클립보드 복사, 스크린 리더 읽기는 확인하지 않았다. | `tests/browser/glossary.spec.ts` | UX-NATIVE-01·QUALITY-01 native 점검에서 함께 확인 |

## 문서·화면 자료

| # | 심각도 | 문제 | 제안 |
| --- | --- | --- | --- |
| U13 | 중간 | 2026-10-02 UX 수정으로 설정 화면 문구(번역 언어 부제, "모델 목록 불러오기", 표시 언어 안내)와 실행 화면 안내가 바뀌었다. `docs/images/locales/*`의 ko/en/ja 소개 화면과 `manifest.json`의 UI 입력 hash는 수정 전 화면이다. | [현지화 관리](localization.md)의 재캡처 절차로 ko/en/ja 화면과 manifest를 함께 갱신(DOCS-01) |
| U14 | 낮음 | 4개 언어 사용 안내(`user-guide` "화면 표시 언어")는 틀린 설명은 없지만, 표시 언어가 즉시 적용된다는 점과 저장하지 않고 설정을 떠나면 확인을 묻는다는 점, 새 설치 안내·"돌아가기" 흐름을 설명하지 않는다. | 4개 언어 사용 안내·앱 도움말에 함께 반영(DOCS-01) |

## 해결 방향 검토 메모 (2026-10-02, 미적용)

U3·U4·U6은 같은 날 후속 작업에서 고쳤다([기록](history/ux-audit-2026-10-02.md#후속-수정--u3u4u6)). U1은 native 확인이 필요해 남겨 두었고, 다음 작업자가 참고할 사실만 남긴다.

- **U1 창 닫기:** 현재 Rust `on_window_event(CloseRequested)`와 `RunEvent::ExitRequested`는 작업 gate(`request_gate`)만 확인한다. 방향: 페이지가 `settingsDirty`를 Rust 상태(예: `AtomicBool`)에 알리는 명령, 닫기·종료 요청 때 그 값이 참이면 보류하고 page에 이벤트를 보내 기존 "저장하지 않은 설정" dialog를 닫기 문구("저장하고 닫기/저장하지 않고 닫기")로 재사용, 사용자가 답하면 플래그를 지우고 창 닫기(창 X) 또는 `app.exit(0)`(⌘Q). 창을 닫은 뒤 이어지는 `ExitRequested(code=None)`도 플래그가 지워져 있어야 통과한다. **native에서만 확인 가능**하며 macOS ⌘Q·창 X·Windows 창 X를 각각 봐야 한다.

## 검증 공백

- 위 목록과 2026-10-02 수정은 Linux browser fixture로만 확인했다. macOS overlay 타이틀바·Windows 창에서 toast 위치, 저장 확인 dialog, 사이드바 "작업 화면 보기"를 UX-NATIVE-01에서 함께 본다.
- 화면 읽기 프로그램·고대비·글자 크기 조절은 이번 점검 범위가 아니다(Phase3 접근성 항목).
- Linux에서 Rust lib 테스트(`cargo test --manifest-path src-tauri/Cargo.toml --lib`)는 GTK/WebKit 개발 패키지 외에 sidecar 바이너리(`src-tauri/binaries/pomi-sidecar-<target>`)가 있어야 build script를 통과한다. 이 환경에서는 sidecar가 없어 실패했다(코드 오류가 아닌 환경 조건). Rust를 바꾸는 작업은 `pnpm sidecar:build` 후 실행하거나 native 환경에서 확인한다.
