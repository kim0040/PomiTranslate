# 용어집 (Glossary)

고유명사와 용어를 항상 같은 방식으로 번역하거나, 번역하지 않고 그대로 두게 하는 기능이다. 이 문서는 Python 핵심부(저장·요청·번역 적용)를 설명한다. 화면(UI)과 Tauri 허용 목록은 별도 작업이다.

## 저장

- 전체 월드 공용: `<data_dir>/glossary/global.json`
- 월드별: `<data_dir>/glossary/worlds/<worldKey>.json` (`worldKey`는 백업 journal과 같은 `world_key()`)
- 한 파일에 항목 최대 2000개. `source` 1~200자, `target` 0~200자, `note` 0~300자. `mode`는 `translate`(항상 `target`으로 번역) 또는 `keep`(원문 그대로). `source`가 같은 항목(대소문자 무시, `caseSensitive`면 구분)은 둘 수 없다.
- 월드별 항목이 같은 `source`의 전체 항목을 덮어쓴다.
- 쓰기는 원자적·내구성 있게 한다. 읽을 수 없는 파일은 `<이름>.damaged-<시각>.json`으로 옆에 보관하고 빈 용어집으로 취급한다(번역은 멈추지 않는다).
- `revision`으로 낙관적 충돌을 막는다. 오래된 `baseRevision`은 `GLOSSARY_CONFLICT`.

## 요청 (질의 lane, 월드 잠금 없음)

`glossary.get` / `glossary.set` / `glossary.import` / `glossary.export`. 입력 오류는 `GLOSSARY_INVALID`이며 메시지는 `entries[3].source: ...`처럼 필드 경로로 시작한다. 저장 실패는 `GLOSSARY_WRITE_FAILED`.

CSV/TSV는 `source,target[,mode,note[,caseSensitive]]` 열이며 머리글은 선택, UTF-8(BOM 있어도 없어도 됨). 따옴표·쉼표·줄바꿈이 든 칸을 지원한다. 내보내기는 스프레드시트가 한글을 바로 읽도록 BOM을 붙인다.

## 번역에서의 사용

- 배치마다 그 배치 텍스트에 실제로 나오는 항목만(영문자·숫자로 시작/끝나는 `source`는 낱말 단위, 최대 80개, 긴 `source` 먼저) 시스템 프롬프트 뒤 `[용어집]` 블록으로 보낸다. 용어는 JSON 문자열로 인용해 데이터로만 취급한다.
- 번역 뒤 검사: 기대한 `target`(translate) 또는 원문(keep)이 없으면 그 문자열만 한 번 더 요청하고, 그래도 어긋나면 그대로 받아들이고 경고 `glossary_mismatch`(항목 id 포함)를 기록한다. 실패가 아니다.
- 대상 언어가 한국어·일본어·중국어일 때, 서식 코드(`§x`) 바로 뒤에 원문 단어의 앞 글자가 1~3자 남은 경우(`§lcrypt` → `§lc지하실`)를 감지해 한 번 재시도하고, 남으면 경고 `format_residue`만 기록한다(자동으로 지우지 않는다). 원문 낱말을 그대로 둔 경우(`§6TNT` → `§6TNT는`)는 잔여가 아니다.
- 경고 개수는 `translation_progress.warnings`와 보고서 `translation_warnings`(코드별 개수), `translation_warning_samples`에 담긴다.
- 직접 번역(검토 화면)은 항상 용어집보다 우선하며 용어집 검사를 받지 않는다.
- 용어집 지문(fingerprint)이 바뀐 뒤 이어하기(resume)하면 월드에 이미 쓴 상태는 유지하고 번역 캐시와 답변 로그는 통째로 버린다(경고 `glossary_changed`).

검증: `python tests/test_glossary.py`, `tests/test_glossary_translation.py`, `tests/test_format_residue.py`. 실제 모델 응답에서의 효과는 합성 fixture로만 확인했고 실제 provider 호출은 하지 않았다.
