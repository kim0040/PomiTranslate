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
