# 언어·문구·에셋 관리

## 제공 범위

| 언어 | 제품 UI | README·사용 안내·개인정보·면책 | 공유·안전 안내 이미지 | 제품 화면 |
| --- | --- | --- | --- | --- |
| 한국어 `ko` | 제공 | 제공 | 제공 | 한국어 3장 |
| English `en` | 제공 | 제공 | 제공 | 영어 3장 |
| 日本語 `ja` | 제공 | 제공 | 제공 | 일본어 3장 |
| 简体中文 `zh` | 제공 | 제공 | 제공 | 중국어 3장 |

UI 언어는 `src/lib/i18n/locale.ts`의 `LOCALES`(ko·en·ja·zh)가 기준이며 카탈로그는 `src/lib/i18n/{ko,en,ja,zh}.ts`입니다. 한국어가 기준 키이고 나머지 카탈로그는 같은 키를 가져야 하며 `pnpm test:frontend`의 카탈로그 일치 검사가 이를 확인합니다. **번역 도착 언어**는 UI 언어와 별도이며 사용자가 언어명을 입력합니다. 개발·상태·지원 표·이력·법적 검토는 한국어 문서이며 해당 링크에서 언어를 안내합니다. 네 언어의 사용자 진입점은 [문서 목록](README.md)을 따릅니다.

## 공통 표현

제품명 **PomiTranslate**, 마스코트 **Pomi**, 공식 부제 **World Translator for Minecraft**는 번역하지 않습니다. 공식 Minecraft 비공식 고지 원문과 MIT·제3자 license 원문도 보존합니다. 월드 원문, 모델 ID, 파일 경로, 명령어·코드·자리표시자는 화면 언어에 맞춰 바꾸지 않습니다.

| 뜻 | 한국어 | English | 日本語 | 简体中文 문서 |
| --- | --- | --- | --- | --- |
| 검토 단계 | 후보 검토 | Review | 候補の確認 | 候选文本检查 |
| 설정 | 환경 설정 | Settings | 設定 | 设置 |
| 직접 입력한 번역 | 직접 번역 | Manual translation | 手動翻訳 | 手动翻译 |
| 번역 결과의 언어 | 도착 언어 | Target language | 翻訳先言語 | 目标语言 |
| UI의 언어 | 화면 표시 언어 | Display language | 表示言語 | 界面语言 |
| 원본 보호 | 백업과 복원 | Backup and restore | バックアップと復元 | 备份与恢复 |

영어 후보 행의 좁은 상태 배지는 **Manual**로 줄이고, 설명·필터·입력창에서는 전체 표현을 사용합니다. UI의 실제 버튼 이름은 각 카탈로그가 기준이며 문서에서 번역을 달리해 찾기 어렵게 만들지 않습니다.

## 에셋 원본과 출력

- 문구 원본: [`assets/localization.json`](../assets/localization.json). 4개 언어의 공유 이미지·스캔·백업·API·미지원 압축 안내를 한 곳에서 관리합니다.
- SVG: `node scripts/generate-localized-assets.mjs`로 20개를 생성합니다. `--check`는 결과가 최신인지 확인합니다.
- PNG: 같은 SVG를 Chromium에서 렌더합니다. 새로운 일러스트를 생성하거나 Pomi의 픽셀을 수정하지 않고, 기존 Pomi 그림을 넣은 벡터 레이아웃으로 문자와 줄바꿈을 관리합니다. 글꼴 파일은 배포하지 않습니다. 시스템 글꼴에 따라 다른 환경의 렌더가 달라질 수 있으므로 Git에 포함된 PNG를 문서에서 사용합니다.
- 공유 이미지: `assets/brand/social/og_default_{locale}_v1.{svg,png}`, 1200×630.
- 안내 카드: `assets/illustrations/docs/doc_{card}_{locale}_v1.{svg,png}`, 1200×720. `card`는 `scan_first`, `backup_first`, `api_notice`, `unsupported`입니다.
- 언어 없는 기존 카드 PNG 4개는 이번 한국어 출력의 호환 별칭입니다. 이전 파일을 남겨 오래된 문구를 재사용하지 않습니다.
- 브랜드 워드마크와 앱 아이콘의 고유 이름·공식 부제는 공통으로 유지합니다. 개발 workspace의 생성 원본은 제품 배포 에셋과 구분합니다.
- 파일 hash·문구 원본/generator hash는 [`assets/localization-manifest.json`](../assets/localization-manifest.json)에 기록합니다.

## 화면 재캡처

[Playwright CLI](https://github.com/microsoft/playwright-cli)를 사용할 수 있는 개발 환경에서 실행합니다. 새 패키지·글꼴은 제품 의존성에 추가하지 않습니다.

```bash
# 터미널 1: 개발 전용 합성 UI
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort

# 터미널 2: API·native sidecar 없이 동일 UI를 사용
mkdir -p docs/images/locales/ko docs/images/locales/en docs/images/locales/ja docs/images/locales/zh
playwright-cli --session=pomi-l10n open 'http://127.0.0.1:5199/tests/frontend/preview.html?scenario=review'
playwright-cli --session=pomi-l10n run-code --filename scripts/capture-docs.playwright.js

node scripts/generate-localized-assets.mjs
playwright-cli --session=pomi-l10n run-code --filename scripts/render-localized-assets.playwright.js
node scripts/update-docs-image-manifest.mjs
playwright-cli --session=pomi-l10n close
```

캡처 entry는 `locale=ko|en|ja|zh`를 검증하고(`scripts/capture-docs.playwright.js`의 언어 표에도 zh가 있습니다), 각 언어의 UI·도착 언어·합성 수동 번역을 초기화합니다. 언어 전환이 실제 번역 대상의 지원을 확장한다는 뜻은 아닙니다. 캡처는 Review→Settings→Run까지만 이동하며 스캔·번역·복원을 시작하지 않습니다. 글꼴·화면 전환·저장 알림이 끝난 뒤 찍고 외부 요청·실행 요청·가로 overflow를 확인합니다. 파일 생성 후 모든 화면을 직접 검토해 빈 화면·잘림·비밀·개인 경로를 확인합니다.

[`docs/images/manifest.json`](images/manifest.json)은 PNG 12개(4개 언어×3) hash, UI/fixture/lock 입력 hash와 이번 한국어 캡처의 기존 URL 3개 별칭을 기록합니다. 소개 화면은 **합성 데이터의 브라우저 캡처**이며 최신 native·실제 provider·설치 검증의 증거가 아닙니다. 과거 PASS를 이번 언어 작업의 결과로 복사하지 않습니다.
