# COMP-02 — 최신 text component 형태 조사와 구현 (2026-10-23)

범위: 직접 NBT(1.21.5+)와 JSON 문자열(그 이전)의 text component 중 추출기가 놓치던 **보이는 글자**. 구현·검증 수준은 **합성 fixture 검증(fixture-verified)** 이다. 실제 게임 버전의 월드 생성/로드는 하지 않았고(COMP-04), "게임에서 지원됨"이라고 쓰지 않는다. 유료 API 호출 없음.

## 조사 출처 (모두 2026-10-23에 읽음)

| 출처 | 확인한 내용 |
| --- | --- |
| [Text component format](https://minecraft.wiki/w/Text_component_format) 본문과 History | `fallback`(translate) 1.19.4 / 23w03a, 값은 String. `hoverEvent` `contents` 1.16 / 20w17a. 1.21.5 / 25w02a에서 `hover_event`·`click_event`로 이름 변경, show_item·show_entity의 `contents` 인라인, show_text `value`(25w03a). `object` 컴포넌트 1.21.9 / 25w32a(atlas·player), `fallback`는 26.1-pre1에서 추가. `separator`는 `selector`·`nbt` 컴포넌트의 text component. `show_entity.name`은 String/List/Compound. `show_dialog`(1.21.6 / 25w20a)는 inline dialog 정의를 가질 수 있음 |
| [Java Edition 26.1-pre-1](https://minecraft.wiki/w/Java_Edition_26.1-pre-1) | "`minecraft:object`: Added a new optional field named `fallback` that contains a text component … (for example when printing messages in server logs or during narration)." → 문자열이 아니라 **text component** |
| [Java Edition 25w32a](https://minecraft.wiki/w/Java_Edition_25w32a) | `object` 컴포넌트 추가(`atlas`, `sprite`). 이 시점에는 fallback 없음 |
| [Java Edition 1.21.5](https://minecraft.wiki/w/Java_Edition_1.21.5), [1.20.5](https://minecraft.wiki/w/Java_Edition_1.20.5) | 1.21.5: tellraw/title 등은 SNBT. 1.20.5: 아이템 `components`, 책 filterable 항목의 `text`→`raw`. (두 페이지 모두 앞부분만 읽혔다) |
| [Data component format](https://minecraft.wiki/w/Data_component_format) | `custom_name`/`item_name`/`lore`는 text component(문자열·리스트·compound). `written_book_content`: `pages[]`는 `raw`+선택 `filtered`(둘 다 text component), `title.raw`/`filtered`는 평문, `author`는 평문. `writable_book_content`: `pages[]` 의 `raw`/`filtered`는 평문. 표지판 `messages`는 text component 4줄 |
| [Template: sign text object](https://minecraft.wiki/w/Template:Nbt_inherit/sign_text_object/template) | `messages` text component 4개, `filtered_messages`는 "Only in Realms", 프로필 필터가 켜진 플레이어에게 보이는 줄 |
| [Entity format](https://minecraft.wiki/w/Entity_format), [Mannequin](https://minecraft.wiki/w/Mannequin) | `CustomName`은 text component. Mannequin(1.21.9)의 `description`은 text component(플레이어 below_name 자리에 표시) |

읽지 못한 출처: minecraft.net의 1.20.5·1.21.5·26.1 공식 변경 내역 페이지는 이번 세션에서 모두 시간 초과였다. 위 wiki 페이지의 history로 대신했으며, 공식 페이지와의 대조는 하지 않았다. `written_book` 구형 `tag.filtered_pages`(1.20.4 이하)의 형태는 어떤 출처에서도 확인하지 못해 **추측해서 구현하지 않았다**(기존 `filtered_title` 처리는 그대로).

## 필드별 비교 (구현 전 `extract.py` 대비)

| 형태 | 구현 전 | 이번 |
| --- | --- | --- |
| `text`, `translate`+`fallback`(문자열)+`with`(중첩), `extra` | 수집 | 변경 없음 |
| `hover_event` show_text `value`, legacy `hoverEvent` `contents` | 수집 | 변경 없음 |
| `hover_event` show_entity `name` | compound/list만 수집 (문자열 이름 누락) | 문자열·JSON 문자열·compound 모두 수집 |
| legacy `hoverEvent.contents.name` (NBT 쪽) | **누락** | 수집 |
| show_item `components`의 `custom_name`/`item_name`/`lore` (인라인 / `contents`) | NBT 쪽 **누락**, JSON 쪽은 compound일 때만 우연히 수집(`custom_data`의 `text`도 잘못 수집될 수 있었음) | 이름·lore만 수집, 설정 스위치(`translate_custom_names`/`item_names`/`lore`) 적용. 1.20.5–1.21.4의 문자열 안 JSON도 처리 |
| `object` 컴포넌트 `fallback` (문자열 또는 text component) | **누락** (translate에 붙은 문자열 fallback만 수집) | 수집. `type:"object"` 또는 `object`/`sprite`/`player` 키로 식별 |
| `selector`/`nbt`의 `separator` | NBT 쪽 누락, JSON 쪽 문자열 누락 | 수집 |
| Mannequin `description` | **누락** | 수집(`translate_custom_names`) |
| sign `front_text`/`back_text` `messages`·`filtered_messages` | 수집 | 변경 없음. 같은 원문은 같은 번역, 없는 쪽은 만들지 않음을 fixture로 고정 |
| written_book_content `pages`/`title` raw·filtered, writable pages, `CustomName` | 수집 | 변경 없음 |
| 수집하지 않는 것(규칙) | — | 키·id·`translate` 키·selector 문자열·NBT 경로·`sprite`/`atlas`/`player`·`click_event` 값·score 이름. `click_event` 안의 tellraw/title 명령 속 component만 기존대로 처리 |

구현하지 않은 것: `attribute_modifiers`의 `display.value`(override 표시 문구, 정확한 버전/경로 미확인), `click_event` `show_dialog`의 inline dialog 텍스트(별도 CONTENT 과제), 구형 `hoverEvent`의 `tag.display.Name`(문자열 속 JSON 중첩).

## 변경 요약

- `mwt/extract.py`: `EXTRACTOR_VERSION` 3→4(수집 범위가 바뀌어 기존 scan plan 무효화). `_walk_json`/`_collect_component_compound`에 object fallback·separator, `_walk_hover`/`_collect_hover_target`에 show_item·show_entity, `description`(mannequin). 이름·lore 처리는 `_collect_tooltip_component`로 모아 책/아이템 경로와 공유.
- `tests/test_component_shapes.py`(신규, `scripts/verify-local.mjs`·CI·`test_release_fixtures.py` 등록): 합성 청크 1개에 모든 새 형태와 "수집하면 안 되는" 문자열을 넣고 scan → write → 재열기 → 번역한 문자열로 같은 fixture를 다시 만든 바이트와 동일(비대상 바이트 보존) → region 월드 write 후 restore가 baseline SHA-256과 일치하는지 확인. 구현 전 코드에서는 12개 텍스트 누락으로 실패한다.
- `mwt/support_matrix.py`/`docs/support-matrix.md`: `text.object_fallback`, `text.hover_item_entity`, `text.selector_separator`, `text.mannequin_description` 행 추가(fixture 통과 시에만 supported).

## 리뷰 수정 (2026-10-23, M1·M2·M3)

교차 리뷰(`review_COMP`)가 COMP-02에서 세 가지를 지적했고 모두 합성 입력으로 재현·수정했다. 게임 로드·실제 provider는 확인하지 않았다(fixture 검증).

### M1. 문자열 속 JSON의 바이트·따옴표 보존

- 원인: 1.20.5–1.21.4식 문자열 속 JSON(`custom_name`/`lore`/`name`)을 `_walk_component_value`가 통째로 compact 직렬화해, 바뀌지 않은 공백·`r` 같은 escape와 SNBT 안의 따옴표 종류까지 바꿨다.
- 수정: `mwt/extract.py`에 작은 JSON 스캐너(`_JsonScanner`/`_JsonDocument`)를 두어 값 문자열 토큰의 위치를 기록하고, `_patch_json_string`이 **바뀐 문자열 토큰만** 다시 인코딩한다. 공백·키 순서·바뀌지 않은 토큰의 escape는 그대로다. 위치로 되돌릴 수 없는 편집(문자열 값이 객체로 바뀜, 중복 키, `json.loads`만 받는 NaN 등)은 이전처럼 compact 직렬화로 되돌리고 `json_span_fallbacks`를 센다(다른 진단 카운터 `unparsed_commands`와 같은 방식. 리포트 연결은 `mc_world_translator.py` 소관이라 이번에는 하지 않았다).
- 바깥쪽 JSON-in-string 경로(`apply_translations`의 `json_tag`, `_walk_command`의 JSON 명령)도 같은 `_patch_json_string`을 쓴다. 공유 함수 하나로 끝나는 작은 변경이라 함께 적용했다. 입력이 이미 compact면 결과 바이트는 이전과 같고, 공백이 있는 입력만 이전에는 compact로 바뀌던 것이 이제 보존된다.
- SNBT: `mwt/snbt.py`의 `quote(..., keep=True)`가 바꿀 문자열의 **원래 따옴표 문자를 유지**하고 그 따옴표에 맞게 escape한다(이전에는 새 텍스트에 같은 따옴표가 있으면 반대쪽으로 바꿨다). 따옴표 없는 단어는 이전처럼 `"`로 쓴다.

### M2. 구형 hover payload 누락

- 원인: `_walk_hover`와 NBT `_collect_component_compound`가 `show_item`/`show_entity`에서 조기 반환하여, 부모(57c784b^1)가 수집하던 `value`(component)·문자열 `contents`/`name`(내장 명령)·component 목록을 버렸다.
- 수정: 새 인라인 필드(`components`, `name`)와 compound `contents`는 이름·lore만 보는 targeted 처리를 유지하고, 나머지는 부모와 같은 처리를 그대로 한다. 부모와 같게 만든 대상: `value`가 component/list, 문자열 `contents`/`name`이 `tellraw`/`title` 명령, `contents`가 list, NBT 직접 `value`/`contents` list/문자열 `name`. 구형 raw SNBT item/entity 래퍼 문자열은 번역으로 보내지 않는다(부모도 보내지 않았다).
- 부모 비교: 실제 부모 `extract.py`를 `git show 57c784b^1`로 불러 같은 입력을 돌려 JSON·JSON-in-NBT·직접 NBT·명령 component 모두 부모와 같은 문자열을 수집함을 확인했고, 그 값을 `tests/test_component_shapes.py`의 `LEGACY_JSON`에 고정했다(테스트가 git 이력에 의존하지 않는다).

### M3. object component

- 명시적 `type`이 이긴다: `type`이 있으면 `object`일 때만 object이고(알 수 없는 type·`minecraft:object`·문자열이 아닌 type은 object가 아님), `type`이 없거나 null일 때만 `object`/`sprite`/`player` 키로 판별한다. JSON·NBT 모두 같다.
- `object`/`player`/`sprite` payload는 JSON 일반 하위 탐색에서 제외한다(중첩 profile·property의 `text`/`extra`도 수집하지 않는다). NBT는 키별 명시 탐색이라 원래 들어가지 않으며 테스트로 고정했다.

### 영향

- 수집 후보가 v4와 달라져(M2로 복원, M3로 제거) `EXTRACTOR_VERSION` 4→5로 올렸다. 이전 scan plan은 무효화된다. 이 변경으로 `docs/compatibility-roadmap-2026-10-01.md` 21행과 `docs/current-state.md` 24행의 "`EXTRACTOR_VERSION` 4" 표기는 5로 고쳐야 한다(이번 작업의 소유 범위 밖이라 두었다).
- 테스트: `tests/test_component_shapes.py`에 7개 추가(바이트 보존·fallback·SNBT 따옴표·구형 hover JSON/NBT·type 우선과 payload 제외·합성 월드 scan→write→재열기→restore baseline SHA-256 일치). 수정 전 코드에서는 7개 모두 실패한다.
