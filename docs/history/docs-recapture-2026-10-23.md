# 소개 화면 재캡처·사용 안내 갱신 (2026-10-23)

[알려진 UI/UX 문제](../ux-issues.md)의 U13·U14를 처리했다. 제품 동작·Phase 상태는 바뀌지 않았다.

## U13 — 소개 화면

- [현지화 관리](../localization.md)의 "화면 재캡처" 절차 그대로 ko/en/ja의 `review`·`settings`·`run` PNG 9장을 다시 찍었다. 합성 dev UI(`tests/frontend/preview.html?scenario=review`, Vite 5199)이며 API·native sidecar·유료 호출·월드 작업은 없다. 외부 요청 0, 가로 overflow 0, 세 화면 모두 직접 보고 빈 화면·잘림·비밀·개인 경로가 없음을 확인했다.
- 화면 구성은 그대로 3장×3언어다. 설정 화면은 이제 "번역"/"앱" 탭과 "모델 목록 불러오기"가 보이는 번역 탭이고, 실행 화면은 중단된 작업 기록 안내와 "이어서 번역"이 보인다. 용어집 화면과 앱 탭은 새 화면이지만 캡처·manifest 스크립트가 3장 구성에 고정돼 있어 더하지 않았다. 더하려면 `scripts/capture-docs.playwright.js`·`scripts/update-docs-image-manifest.mjs`·언어별 README 표를 함께 고쳐 모든 언어에서 같은 장수로 유지해야 한다.
- `docs/images/manifest.json`(UI 입력 hash `sourceHash`, PNG hash·크기)과 `docs/images/README.md` 표를 갱신했다. 한국어 호환 별칭(`docs/images/{review,settings,run}.png`)은 새 ko 캡처와 같다.
- 캡처 환경은 Windows 10 / Playwright Chromium이다. `playwright-cli`가 없어 같은 스크립트 본문을 `@playwright/test`의 Chromium에서 실행했다. manifest 스크립트는 `environment`를 `macOS / Playwright Chromium`으로 고정해 적기 때문에 `manifest.json`의 값을 실제 환경으로 고쳤다.
- SVG는 `node scripts/generate-localized-assets.mjs --check`로 최신임을 확인했고(문구 원본 변경 없음) 공유 이미지·안내 카드 PNG는 다시 렌더하지 않았다. Windows 글꼴로 다시 렌더하면 기존 PNG가 이유 없이 바뀌므로 `assets/localization-manifest.json`의 날짜도 그대로 두었다.

## U14 — 사용 안내

4개 언어 사용 안내(`user-guide`, `.en`, `.ja`, `.zh`)를 같은 내용으로 갱신했다.

- 앱 탭에서 고른 화면 표시 언어가 즉시 적용되고 저장 버튼이 없다는 점, 저장하지 않은 번역 탭 설정을 두고 앱 탭·다른 화면으로 옮기면 저장·저장 안 함·계속 편집을 묻는다는 점.
- "처음 설정과 돌아가기": 시작 안내의 "API 키 설정하기", 월드·스캔·실행 화면의 설정 안내, 열린 설정의 "돌아가기"와 "저장하고 돌아가기".
- 키 저장 뒤 모델 목록 자동 조회, 진단 정보 복사·파일 저장(앱 탭 데이터 보관 위치 아래와 오류 화면), 실패 뒤 결과 화면의 첫 단추.
- zh 안내는 중국어 UI가 없으므로 영어 UI로 읽어야 하며 버튼·메뉴 이름과 화면이 영어임을 첫머리에 밝힌다.
- 용어집 절은 네 언어에 이미 있어 바꾸지 않았다. README(en/ko/ja/zh)에는 설정이 번역/앱 탭으로 나뉜다는 한 문장만 더했다.
- 앱 도움말(`HelpScreen`)은 UI와 모순되는 문구가 없어 바꾸지 않았다. FAQ의 "환경 설정 > 업데이트/초기화/데이터 보관 위치"는 이제 앱 탭 안에 있지만 경로 표기로는 여전히 맞다.

## 확인하지 않은 것

native 창·실제 provider·macOS/Linux 렌더는 확인하지 않았다. 소개 화면은 합성 데이터의 browser 캡처이며 native·설치 검증의 증거가 아니다.
