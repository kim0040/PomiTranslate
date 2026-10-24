# main UX 개편·리뷰 수정 WIP 병합 — 2026-10-24

> **판정:** 병합됨, **병합된 소스에서 검증됨**(자동 검사 69/69·browser 419 PASS(1 skip)·Windows 설치본 native E2E PASS). 이 기록은 무엇을 합쳤는지, 문서 쪽 결정, 리뷰에서 고친 것과 병합된 소스에서 실행한 검사를 남긴다. 병합 전 각 갈래의 PASS 수치를 이 병합의 결과로 복사하지 않는다. Phase 상태는 바뀌지 않는다: Phase2 개발 환경 gate 완료 / Phase3 진행 중 / release-ready 아님.

## 무엇을 합쳤나

- **받는 쪽(OURS):** 브랜치 `improve/commercial-readiness`. 2026-10-02(`ad9f2c6`)부터 2026-10-23(`8247f6f`)까지 172 commit의 상용 수준 점검. Windows native(설치본·UI Automation)·Docker Linux·`pnpm verify:local` 60/60으로 검증했다. 병합 전 상태는 브랜치 `backup/commercial-readiness-pre-merge`.
- **들어온 쪽(THEIRS):** `integrate/main-wip-2026-10-24` = origin/main의 2026-10-03~10-11 UX 개편([기록](ux-overhaul-2026-10-04.md)) + 검증하지 않은 리뷰 수정 WIP 3개(`core-safety` `5b4150d`, `native-security` `f3ebeee`, `ui-ux` `99b7efd`; [인계](review-fixes-pause-2026-10-11.md)). 공통 조상은 `ad9f2c6`.
- 사용자 결정: main과 WIP 셋을 모두 합친다. push하지 않는다.

## 해결 원칙

1. 양쪽의 사용자 기능과 안전 수정을 모두 남긴다. 같은 문제를 다르게 푼 곳은 commercial-readiness에서 이미 검증한 구현 하나만 남기고, THEIRS가 OURS에 아직 있는 실제 결함을 고친 경우에만 그 수정을 OURS 구현에 옮긴다.
2. commercial-readiness의 구조가 기준이다: PyInstaller onedir sidecar를 요청마다 실행(Windows Job Object·Linux PDEATHSIG·macOS stdin EOF·cancel marker·강제 종료), Rust가 자격 증명을 소유(`credentialOwner: "rust"`, 암호화 SQLite vault + 설치별 key 파일, OS keychain은 opt-in이며 자동으로 읽지 않음, Rust 소유 요청에서 Python은 keyring에 손대지 않음), `exit_gate.rs`, `window_geometry.rs`, UPPER_SNAKE 오류 코드(`error.<CODE>` 문구, `src-tauri/src/error.rs`·`diagnostics.rs` 목록 검사). THEIRS의 소문자 `cost_cap_unpriced`는 `COST_CAP_UNPRICED`로 맞춘다.
3. UI 언어는 ko/en/ja/zh. 카탈로그 키는 네 언어에 모두 있어야 한다.

## 문서 쪽 결정

- 현재 상태·추후 작업·알려진 UI/UX 문제·현지화 문서는 commercial-readiness의 2026-10-23 상태, main의 2026-10-04 개편, 2026-10-11 리뷰 수정 WIP를 한 장면으로 합쳤다. 병합된 소스에서 실행하지 않은 것은 PASS로 쓰지 않았다.
- 알려진 UI/UX 문제의 번호 충돌: main의 U20(번역 결과 검토 원문 칸의 `lang`)은 commercial-readiness가 이미 U20(용어집 내보내기 저장 창)을 고쳐 지웠으므로 **U24**로 옮겼다.
- 사용자 안내 4개 언어는 main의 설정 도우미·네 개 설정 탭·비용 한도·단가 직접 입력·가격 모름 확인·새 단계 이름을 기준으로 하고, commercial-readiness의 앱 탭 즉시 적용·저장 확인·진단 파일 저장·초기화 부분 실패 안내·용어집 화면·가격표 출처·CLI 옵션을 더했다. 개인정보 4개 언어에는 Custom 키가 서버 주소에 묶이는 것과 데스크톱 코어가 keyring을 쓰지 않는 것을 더했다.
- 중국어 안내는 이제 중국어 UI의 버튼 이름을 쓴다(이전에는 영어 UI 이름으로 안내했다).
- 소개 화면 12장: 한국어·영어·일본어는 commercial-readiness가 2026-10-23에 다시 캡처한 것, 중국어는 main의 2026-10-04 캡처다. 출처가 다르므로 `docs/images/manifest.json`에 `captures` 목록으로 구분해 적었다. **병합된 UI가 안정되면 12장을 모두 다시 캡처해야 한다.**

## 병합된 소스의 검증

모두 2026-10-24 Windows 10에서 병합된 소스(스테이징된 최종 상태)로 실행했다. 실제 유료 제공사 호출은 없다.

**독립 리뷰와 수정.** 구현한 모델과 다른 계열이 리뷰했다.
- Python(GPT Sol이 해결 → Claude Sonnet 리뷰): 데이터 손실·월드 손상·키 유출 경로는 없었다. High 1(용어집을 행마다 다시 만들어 큰 월드에서 checkpoint 저장·검토 페이지가 분 단위로 느려짐, 병합이 만든 회귀)과 Medium 5(적용한 작업에 "이어서 번역"이 제안되어 다시 적용이 깨짐, `_resume_candidate`의 변수 누수, 옛 `glossary.set`이 revision 검사를 건너뜀, 병렬 스레드에서 비용 한도가 안 지켜짐, Custom 계열 직접 단가 거부)와 Low 7을 고쳤다. 회귀 테스트 23개(`tests/test_merge_review_fixes.py`)는 각각 수정을 되돌리면 실패하는 것을 확인했다.
- frontend·Rust(Claude Sonnet·Opus가 해결 → GPT Sol 리뷰): High 1(가격 정보가 없는 모델로 번역해 검토 화면까지 가면 남아 있는 경고의 버튼이 검토한 번역을 적용하는 대신 **유료 번역을 처음부터 다시 시작**)과 Medium 3(Custom의 "실패한 것만 다시 번역"에 서버 주소가 빠져 항상 거부, 스크롤한 검토 표가 Tab 순서에서 빠짐, 번역 수정만 남았을 때 성공할 수 없는 "저장하고 종료")을 고쳤다.
- 병합 전부터 있던 결함 2개도 고쳤다: "저장된 진행 기록 버리기"(`resume.discard`)가 Rust 허용 목록에 없어 동작하지 않았고, "격리 폴더 열기"가 없는 Rust 명령을 불러 경로 복사로만 끝났다(새 `reveal_quarantine_folder`는 `quarantine` 폴더 바로 아래의 실제 폴더만 연다).

**자동 검사.**
- `pnpm verify:local`(Python·frontend·Rust): **69/69 PASS**(769.6초). Python 전체, `pnpm check` 0 오류/0 경고, vitest, license 검사, `cargo fmt`·`clippy -D warnings`·`cargo test --lib` 252 PASS.
- `pnpm exec playwright test --workers=2`: **419 PASS, 1 skip**(병합 전부터 `fixme`인 `native-polish.spec.ts:278`).
- `pnpm desktop:build`(sidecar clean 재빌드 + Tauri release + NSIS): PASS, 설치 파일 18.32 MiB.

**Windows native(설치본, UI Automation, loopback 가짜 제공사·더미 키).**
- 새 설치 파일을 조용히 설치했고(exit 0), 설치된 exe는 빌드 결과와 bundle 표시 3바이트만 다르다.
- 첫 실행 설정 도우미 5단계: 언어 4개, Custom 선택 시 Base URL을 넣기 전까지 "다음" 비활성, 저장 전 초안 키로 연결 확인(`draftApiKey` → Rust → 제공사, 키 일치), 모델 목록, 도착 언어·문체·비용 한도 저장.
- 키 저장: 데이터 폴더 563개 파일에서 평문 키 0건(실행 중 WebView가 잠근 일부 파일은 읽지 못함). 키는 `credentials.sqlite`(암호화)와 설치별 `master.key`에 있다.
- 월드 폴더 선택(Windows 폴더 선택 창) → 스캔(표지판 3개) → 가격 없는 모델의 한도 경고 → "한도 적용 없이 시작" → 첫 전송 확인 → 번역(제공사 요청 1회, 3개) → 검토 화면. 이 단계에서 월드 내용 파일 6개의 SHA-256은 기준과 같았고, 검토·결과 화면에는 경고 버튼이 없었다(High 수정 확인).
- 행 하나를 직접 고친 뒤 창 닫기: "저장하지 않은 번역 수정이 있습니다"에 "계속 수정"·"수정을 버리고 종료"만 나왔다(Medium 수정 확인). 계속 수정 → 월드에 적용: 추가 제공사 요청 없이 파일 5개에 썼고, 직접 고친 문장(외부 청크 `c.0.0.mcc`)과 AI 번역 2개가 실제 월드에 들어갔다.
- 백업 관리에서 "번역 전 자동 백업"으로 복원: 내용 파일 6개의 SHA-256이 기준과 **정확히 같고**, 적용 때 생긴 외부 청크 파일은 지워졌다. "복원 직전 안전 스냅샷"이 남았다.
- 창 닫기로 정상 종료: 앱·sidecar·WebView 프로세스가 남지 않았다.
- 월드 폴더의 `.pomi-translate/write.lock`(빈 잠금 파일)은 이전 실행부터 있던 코어의 월드 잠금 파일이며 비교에서 뺐다.

**확인하지 않은 것.** 실제 유료 제공사, Minecraft에서 월드 로드(EULA), 서명·업데이트·공개 릴리스, macOS, 실제 Linux 데스크톱, 화면 낭독기, 이번 설치본의 제거(제거 hook은 병합에서 바뀌지 않았고 2026-10-23 설치본에서 확인했다).

## 남은 일

- WIP 3개가 인계 문서에 남긴 "남은 일"이 병합 뒤에도 필요한지: core-safety의 전체 Python suite 실행과 R8·R10 회귀 테스트, ui-ux의 browser spec 갱신과 접근성 확인, 새 오류 코드 문구, ja/zh 용어 점검.
- `docs/support-matrix.md`는 fixture 결과로 생성하는 문서다. 1.20.3–1.21.4 JSON 문자열 컴포넌트(`json_string_tag`, `tests/test_text_components.py`) 행은 그 fixture를 병합된 소스에서 실행한 뒤에 더한다.
- ~~소개 화면 12장 재캡처와 manifest 갱신~~ 2026-10-24 병합 커밋 뒤 별도 커밋에서 끝냈다: 병합된 UI에서 ko/en/ja/zh 12장을 한 번에 다시 찍었고(Windows 10 / Playwright Chromium, 외부 요청 0), 캡처 스크립트를 새 단계 이름에 맞췄다. 캡처에서 보인 설정 화면의 중복 제목(문체 묶음 제목과 첫 칸 이름이 같음, 중국어 단가 묶음 제목과 입력 칸 이름이 같음)도 고쳤다.
- native 확인(UX-NATIVE-01)과 각 OS 확인은 [추후 작업](../follow-up-work.md)을 따른다.
