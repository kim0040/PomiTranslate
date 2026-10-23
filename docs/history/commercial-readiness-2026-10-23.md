# 상용 수준 점검·개선 — 2026-10-23

브랜치 `improve/commercial-readiness`(로컬, push 안 함). 전체 코드베이스를 UI/UX·기능·안정성·보안·배포 관점에서 다시 점검하고, 교차 검증한 결과를 웨이브 단위로 고친 기록이다. **release-ready 판정이 아니다.** 아래 "남은 증거"를 채우기 전에는 Phase나 배포 상태를 바꾸지 않는다.

## 1. 점검 방법

- 영역별 독립 점검: Python 코어(쓰기 안전·형식·제공사), Rust/Tauri 셸(자격 증명·종료·sidecar·보안 설정), 프런트엔드 로직(흐름·접근성·i18n), 시각 디자인(24개 화면 × 테마 × 언어 × 크기 스크린샷), 배포·문서·CI.
- 다른 모델 계열이 각 발견을 재현·반박해 심각도를 교정했다(Windows 실측 포함). 이 문서의 심각도는 교정 후 값이다.
- 구조 결정(프로세스 모델, 쓰기 저널, 저장소, 데이터 위치)은 별도 설계 메모와 반대 계열 검토를 거쳐 웨이브 순서를 다시 정했다(§3).

## 2. 주요 발견 (교정 후)

| 심각도 | 내용 |
|---|---|
| Critical (Windows) | 자격 증명 master key를 연 채로 rename → Windows에서 키 저장 자체가 실패(Rust 테스트 6개 실패로 재현). 기본 메뉴의 Quit 항목이 종료 확인·작업 보호를 우회. 월드 쓰기 잠금이 `os.kill(pid, 0)`으로 생존 확인 → Windows에서 죽은 PID도 살아 있다고 판정하거나 반대로 오판. |
| High | Windows에서 리소스팩 ZIP 쓰기마다 읽기 전용 핸들 fsync로 Errno 9(리소스팩 번역 전부 실패). 복원이 잠금 없이 실행. 레거시 JSON 문자열 컴포넌트(`"\"Hello\""`)를 따옴표 없는 글자로 다시 써 JSON이 깨짐. 영구 400 오류에 문자열 40개당 요청 138회. 체크포인트·백업 검증의 제곱 비용. 리뷰 표의 빈 191px 띠, Windows에서 영어·일본어를 Malgun Gothic으로 렌더링. 레거시 웹 서버의 인증·Origin 검사 부재와 클라이언트 지정 경로 쓰기. |
| Medium | 백업·manifest fsync 부재, 결과 화면이 실제 기록 파일 수를 0으로 보고하는 경로, 자격 증명 리디렉트 전달, 다른 제공사 키 차용, 서식 지정자(`%02d`, `%1$.2f`) 누락, 리뷰 작업이 확인 없이 사라지는 흐름, 번역 키 누락 시 화면 전체 예외, 응답 없는 호출이 큐 전체를 막음 등. |

전체 목록·증거는 작업 중 산출물(로컬 scratchpad)에 있으며, 고친 항목과 남은 항목은 아래 표와 [추후 작업](../follow-up-work.md)에 옮겼다.

## 3. 교정된 웨이브 계획

- **A — 현재 구조에서 릴리스 차단 결함 수정.** UTF-8/stdout 분리, 키 파일, Windows 종료, 업데이트 취소, 복원 잠금·finally, 안정적인 월드/세션 잠금, 손상 리전·중복 ZIP·텍스트 형식 보존, 자격 증명 경로·마스킹, 제공사 예산, 레거시 웹 노출.
- **B — 안전한 쓰기 트랜잭션·중단 경계.** 작업별 저널(사전 이미지·부재·의존 순서), 잠금 아래 멱등 복원/복구, 충돌 보존, 물리 커밋 기준의 정직한 보고.
- **C — 패키징·감독되는 작업.** onedir sidecar, Job Object/프로세스 그룹, 종료가 확인된 강제 중지, 진단 번들.
- **D — 데이터 위치 이전 후 색인 저장소.** copy-first 세대 이전, 이후 SQLite.
- **E — 선택 품질 작업.** 번역 메모리, 용어집, 검색, 보존 정책.

잘라내지 않는 것: 쓰기 전 백업 순서, 손상 저장 구조의 정확한 보존 또는 거부, 실제 작성자와 맞물리는 잠금, 자격 증명 격리·마스킹, 안전한 복원, 파일별 복구 가능 상태와 부재 기록, 알 수 없음/부분 결과의 정직한 보고, 입력·네트워크 작업의 상한, 플랫폼 주장에 대한 native 증거.

## 4. 웨이브 A 결과

| 영역 | 고친 내용 | 증거 (Windows 10, 이 브랜치) |
|---|---|---|
| 코어 쓰기 안전 | OS가 보유하는 `write.lock`(Windows `msvcrt.locking`, POSIX `lockf`), PID 추정·unlink 제거, 프로세스 내 레지스트리, 구 잠금 이전; `session.lock`을 Java와 같은 레코드 잠금으로; 복원 전 경로 잠금; `run()` 바깥 finally; 백업·manifest durable write; 임시 파일 누수; 손상 슬롯 바이트 보존 또는 리전 거부; ZIP `ZipInfo` 읽기·중복 멤버; 압축 해제 상한; 부분 실행 체크포인트 유지; 설정 저장 실패가 성공 결과를 가리지 않음; JSONL UTF-8·stdout 격리·NaN 차단 | 40리전 합성 월드 16.1초 → 6.5초. Python 테스트 31개 파일 전부 통과 |
| 제공사·형식 | 자격 증명 리디렉트 거부, 선택 제공사 키만 사용, 잘라내기 전 마스킹, 400/401/403/404 분류, 출력 상한 전달, 사용량 정규화, Retry-After 두 형식, 응답 크기·총 시간 상한, 레거시 JSON 문자열 컴포넌트, Formatter 문법, SNBT surrogate·중복 키, 레거시 웹 토큰·Host·Origin·JSON 검사와 서버 소유 경로 | 영구 400: 요청 138회 → 4회. 관련 테스트 11개 파일 통과 |
| Rust 셸 | key 파일 핸들 해제 후 rename, 초기화 잔여물 복구·격리, 저장소 오류를 데이터로 반환(`credentialState`), keychain 정리, 비동기 자격 증명 명령, Custom 키의 엔드포인트 결합, 명시 메뉴(기본 Quit 제거)와 단일 종료 경로·확인 대화상자, 지역화 메뉴, 업데이트 시간 제한·취소, sidecar UTF-8 환경·hello 이후 잡음 줄 허용·종료 코드·stderr 링 버퍼와 로그 파일·panic 기록, Mutex poison 복구, 구조화 오류 코드, 최소 capability·CSP 강화·탐색 차단, 번들 대상·NSIS 설정·release profile | `cargo test --lib` 23 통과/6 실패 → 87 통과/0 실패. `pnpm check` 0/0, 프런트엔드 75개, 브라우저(종료·자격 증명·시작) 14개 통과 |

반대 계열 검토(Python)는 Critical 0 / High 1 / Medium 7을 찾았다. 디렉터리 fsync 실패 시 이미 바뀐 파일을 0개로 보고하는 경로(High), 제공사·코어의 재시도 분류 불일치, Formatter 인자 결합, 일부 손상 헤더, 잠금 메타데이터 정리 실패, DNS 단계의 시간 상한, traceback 마스킹, UI 미연결 코드다. 모두 웨이브 B 작업에 배정했다.

## 5. 웨이브 B 결과 — 쓰기 저널과 재시도 계약

| 영역 | 고친 내용 |
|---|---|
| 쓰기 저널 | 작업별 `journal.json`(사전 이미지 hash·부재 기록·단위 순서), 잠금 아래 멱등 롤백/유지(Keep), 충돌 파일 격리(hash 접두사 이름), 물리 커밋 기준 보고. 정리되지 않은 기록은 모든 저장소에서 그 월드의 쓰기를 막는다(`RECOVERY_REQUIRED`). 세대 번호로 오래된 기록의 복구를 막는다(`JOURNAL_SUPERSEDED`). Keep은 검증만 하고, 한 단위(region+외부 chunk)가 섞이면 `UNIT_INCONSISTENT`. 쓰기 직전마다 대상 identity를 다시 확인(`WORLD_CHANGED`/`TARGET_CHANGED`). 백업은 항상 켠다(`backup_always_on`). |
| 중단된 이어하기 | 이어하기 기록을 먼저 저장한 뒤 이전 작업을 닫는 사이에 강제 종료되면 두 기록이 서로를 막던 교착을, 아무것도 쓰지 않았음이 hash로 증명될 때만 이전 상태로 되돌리는 정합(reconcile)으로 풀었다. 증명 못 하면 기존 거부를 유지한다. |
| 세대 카운터 | 월드마다 `world-state.<월드 키>.json`, 모든 저장소의 카운터와 기록 중 최댓값 + 1, 카운터 durable write가 성공해야 기록을 받는다. 읽을 수 없는 카운터는 거부, 손상된 카운터는 시각 기반 하한. |
| 재시도 계약 | `ProviderError.kind`(redirect·auth·config는 즉시 중단, too_large·filtered·rejected는 즉시 분할, 연속 거부 3회 차단). 영구 400은 3회로 끝난다. |
| 프런트엔드 흐름 | 리뷰 초안 저장·복원, 백업 사용량과 마지막 사본 보호 삭제·정리, 진행 화면의 최근 번역 3개(160자)와 제공사가 보고한 비용, 완료 알림 설정. |

증거(Windows 10, 합성 월드): 실제 프로세스 강제 종료(`os._exit`) 75행 — durable replace 직전(임시 파일 존재)·직후, 복구 격리 중, 이어하기 handshake 각 저장 앞뒤 — 모두 롤백 후 SHA-256 사전이 기준과 같다. 저장 실패 주입 22행. 반대 계열 검토 3회(1차 High 6 / Medium 3 → 2차 High 2 / Medium 3 → 3차 Medium 1)를 모두 고치고 재현 스크립트로 다시 확인했다.

## 6. 웨이브 C 결과 — 패키징·감독·셸 보안

| 영역 | 고친 내용 |
|---|---|
| 패키징 | PyInstaller onedir sidecar를 `bundle.resources`로 동봉. 로컬 검증 스크립트 `pnpm verify:local`(GitHub Actions 없이 같은 목록 실행). |
| 프로세스 감독 | Windows Job Object(CREATE_SUSPENDED → 할당 → 재개), POSIX 프로세스 그룹. 대기 실패는 종료로 보지 않고 `CORE_STATE_UNKNOWN`으로 슬롯을 유지. 실패한 spawn도 정리될 때까지 추적. 짧은 질의는 120초(프롬프트 다듬기 630초) 절대 기한, 월드 작업에는 일괄 시간 제한이 없다. |
| stdin EOF | 코어는 stdin 끝을 별도 스레드로 감시한다. 끝나면 새 요청을 시작하지 않고 실행 중인 작업을 협력 취소하며, 10초 안에 멈추지 않으면 스스로 종료한다(macOS처럼 부모 종료 신호가 없는 곳의 유일한 보호). |
| 응답 계약 | 같은 id의 유효한 `response.ok`(객체 payload)·`response.error`(code·message)만 교환을 끝낸다. 그 밖의 줄은 무시하거나 protocol fault로 처리한다. |
| 진단 | 내보내기와 로그 파일에 자유 텍스트가 없다: 알려진 traceback 모양(모듈 경로·줄 번호), 허용 목록의 예외 이름, 고정 문장만 남고 나머지는 `[n lines omitted]`. 키·월드 텍스트를 합성 비밀값으로 모든 경로에서 확인. |
| 자격 증명 | 키·vault 디렉터리의 reparse/심볼릭 링크·소유자·ACL 검증과 핀 고정. 이전 버전의 주소 미결합 Custom 키는 주입하지 않고 다시 입력받는다(`CREDENTIAL_ENDPOINT_UNBOUND`). OS keychain 소유는 이름 공간으로 정한다: 앱은 `PomiTranslate/<제공사>` 항목만, 사람이 키 삭제·저장 방식 변경·키 삭제를 포함한 초기화를 요청할 때만 지우고 목록을 훑지 않는다. vault가 Keychain 방식이거나 keychain에 저장한 적이 있다고 기록한 제공사만 OS 저장소에 접근한다(keychain을 쓴 적 없는 사용자는 OS 호출 0회). 항목이 없으면 지운 것으로 보고, OS가 삭제를 거부하면 `KEYCHAIN_UNCONFIRMED`. vault를 읽을 수 없을 때의 초기화만 모든 제공사를 시도하며, 이때 저장소 자체가 없으면(`NoDefaultStore`) 지울 것이 없는 것으로 본다. 앞선 추론형 소유 기록(ledger)은 검토 4회 동안 결함이 반복되어 제거했고, 남은 `keychain-ledger.json`은 시작·초기화 때 지운다. |
| 종료·업데이트 | 종료와 업데이트 설치가 같은 의도(intent id) 경로를 쓴다. 미저장 설정은 저장/버리기/취소, 늦은 답은 무시. 초기화·키 저장소 초기화·업데이트 설치는 코어가 없거나 상태를 모를 때 거부(유지보수 가드). |
| 시각 디자인 | Pretendard 번들, 대비를 측정한 밝은/어두운 팔레트, 공통 화면 컴포넌트, 리뷰 표의 빈 띠 제거, 설정 두 칸 구성, 실행 화면 실시간 보기, 결과 화면 요약. 24개 화면 × 테마 × 언어 × 크기 스크린샷 비교. |

반대 계열 검토 4회(High 5 / Medium 6 → High 4 / Medium 6 → High 3 / Medium 2 → keychain 소유 기록 결함)로 고쳤고, 4차 결과에 따라 keychain 소유를 이름 공간 규칙으로 바꿨다. Unix 코드 경로는 이 Windows 호스트에서 컴파일하지 못했다(아래 남은 증거).

## 7. 번역 품질 (QUALITY-01 일부)

- 용어집: 전체 월드용과 월드별(월드 항목 우선), 항목마다 "원문 그대로" 또는 "항상 이 번역". 배치에 실제로 나오는 용어만 프롬프트에 데이터로 넣는다. 지키지 않은 문장은 한 번만 다시 묻고, 그래도 다르면 경고 `glossary_mismatch`. 용어집이 바뀌면 이어하기에서 이전 번역을 재사용하지 않는다. CSV/TSV 가져오기·내보내기.
- 서식 코드 옆 원문 잔여 글자(`§lcrypt` → `§lc지하실`): 한국어·일본어·중국어 대상에서 감지해 한 번 다시 묻고, 남으면 경고 `format_residue`.
- 용어집 화면: 전체/월드 목록, 검색·편집·삭제, 저장 충돌·잠금(`GLOSSARY_BUSY`)·잘못된 칸 안내에서 편집 유지, 저장 중 편집 잠금, 떠나기·종료 보호, CSV/TSV 가져오기(합치기/통째로 바꾸기, 건너뛴 줄과 이유), 앱에서는 저장 창으로 내보내기(실패하면 클립보드), 검토 화면의 "용어집에 추가", 진행·결과 화면의 품질 경고와 놓친 항목 표시. 글자 수 제한은 코어와 같은 코드 포인트 기준, 중복 검사는 코어의 `casefold`와 같은 표(공유 fixture로 두 쪽을 함께 검사).
- 경계 규칙: 띄어쓰기 문자(라틴·그리스·키릴)는 단어 경계, 한글·가나·한자는 부분 일치. 켈빈·옴 기호 같은 호환 글자는 정규화한 글자로 판단한다. 한 요청에 80개를 넘는 규칙은 `glossary_truncated`로 알리고, 비정상 종료 뒤 다시 확인할 때도 원래 요청에 들어간 규칙만 적용한다.
- 반대 계열 검토 2회(코어 15건 → UI·코어 Medium 3 / Low 3)를 고쳤다.
- 실제 제공사로는 확인하지 않았다(유료 호출 없음).

## 7a. 진단·자격 증명 후속

- 진단 정보를 클립보드 복사 외에 파일로 저장(설정·오류 화면, 셸의 저장 창). 창 위치를 모니터 안으로 되돌리는 일은 셸이 맡고 페이지의 중복 코드를 지웠다.
- keychain 이름 공간 소유의 후속 검토(High 2 / Medium 2)를 고쳤다: OS에 쓰기 전에 "keychain에 저장한 적 있음" 기록을 먼저 확정하고, 확정하지 못하면 쓰지 않는다. 읽을 수 없는 vault에서 삭제가 거부되면 다시 시도할 근거를 새 vault에 남기거나 기존 vault를 그대로 둔다. keychain에서 가져오기는 원본을 남기는 복사이며 Keychain 방식에서는 제공하지 않는다. 저장 방식 전환은 Keychain을 떠날 때만 OS 항목을 지운다. 이전 소유 기록 파일 정리는 확인한 앱 폴더 안의 정해진 이름만 지운다.

## 7b. 화면 UX 후속 (UX-WEB-01)

- 환경 설정을 "번역"(저장 필요)과 "앱"(즉시 적용) 탭으로 나눴다. 저장 막대와 미저장 확인은 번역 탭에만 있다. 키를 저장하면 모델 목록을 한 번 자동으로 불러오고, 목록에 없는 ID와 글을 만들지 않는 저장된 모델(음성·이미지 등)은 막지 않고 경고한다. [설정 기록](settings-parts-2026-10-23.md)
- 실패 결과에서 이어서 할 기록이 있으면 "남은 문장만 이어서", 없으면 "같은 스캔으로 다시 번역"(예상 비용 다시 표시)을 첫 행동으로, 처음부터 스캔은 두 번째로 둔다. 재방문 시 월드 요약, 백업 목록의 두 줄 행, 결과 숫자 이름(적용함/일부 적용/준비만 됨), 사이드바·진행 화면 공용 시계와 충분히 진행됐을 때만 보이는 남은 시간 추정.
- 선택지가 있는 dialog(저장 확인·시작 안내·용어집·좁은 창 후보 상세)는 모서리 X를 숨긴다. Escape는 안전한 선택이다.
- 반대 계열 검토(Medium 1 / Low 3)로 멈춘 진행·재시도·취소 중 남은 시간 숨김, 설정 메뉴의 탭 이동, 탭 전환 취소 뒤 초점을 고쳤다.

## 7c. 제공사 후속 (PROVIDER-01 코드 부분)

- Gemini thinking 최저 단계를 앱 데이터에 30일 기억하고, 같은 모델을 동시에 배우는 batch는 한 learner의 결과를 기다린다. 취소·치명 오류 뒤에는 기다리던 batch도 요청을 보내지 않는다.
- 모델 목록에서 번역에 쓸 수 없는 모델(임베딩·음성 전용·이미지·영상·실시간·robotics·computer-use 등)을 빼되, 글을 출력할 수 있는 모델은 다른 출력이 함께 있어도 남긴다. 저장된 모델은 빠지지 않고 표시된다.
- 반대 계열 검토(High 1 / Medium 5 / Low 3)를 반영했다. 가격표 기반 비용 추정과 실제 Gemini 확인은 남았다.

## 7d. 이 시점의 자동 검사 (Windows 개발 환경)

- `700aad8`에서 `pnpm verify:local` 57/57 PASS(Python·frontend·Rust: Rust lib 247 PASS/5 ignored, clippy·fmt, vitest 250). 같은 소스에서 browser fixture 전체 Playwright 293/293 PASS(2 workers, 21.9분). 같은 날 앞선 실행에서 `test_webui_security`가 부하 중 한 번 실패하고 단독 실행에서 통과했다(부하 의존 불안정, 원인 미확정).
- 반대 계열 검토는 Codex 사용 한도로 마지막 제공사 수정 재검토를 끝내지 못해, 구현(Sonnet)과 다른 모델(Opus)이 대조 검토했다(대기 중 로더 import 위치 한 건 수정).

## 7e. 같은 날 두 번째 묶음

- **COMP-02**(최신 component): object fallback·hover item/entity 이름·selector/nbt separator·mannequin description 수집·되쓰기. 반대 계열(Sol) 검토의 M1–M3과 재검토 R3을 고쳤다: 중첩 JSON은 바뀐 문자열 구간만 고쳐 쓰고(구간을 못 찾으면 이전처럼 compact 직렬화, 집계됨) SNBT 따옴표를 유지, 구형 hover `value`/문자열 `contents`는 이전 추출기와 같은 결과, component 종류는 명시한 `type`을 먼저 한 번 정한다. `EXTRACTOR_VERSION` 5. 합성 fixture로 scan→write→reopen→비대상 바이트 보존→baseline SHA-256 복원 확인, 게임 로드 미확인([기록](comp02-component-shapes-2026-10-23.md)).
- **COMP-03**(chunk별 coverage): DataVersion·압축·상태를 dimension·파일 종류별 개수로만 모아 report와 화면에 보이고, 시험한 최신 DataVersion(4556)보다 새 chunk가 있는 월드는 시작·이어서 하기 전에 한 번 확인하며 core도 확인 없는 요청을 거부한다. 검토 M4·M5·L1·L2와 재검토 R1·R2·R4를 고쳤다: 중단된 작업 이어서 하기 안에서 확인, 파일당 상한을 넘어도 flag·범위 정확, partial 표시 보존, 읽은 chunk는 processed(쓰기 차단 파일은 따로 집계), 시작·재개 한 번에 하나, 오래된 조회 결과 폐기, 이전 checkpoint 읽기 호환. 마지막 확인에서 남은 낮음 2건 중 잘못된 폴더 선택이 대기 중인 복구 조회를 버리던 문제(R5)는 고쳤고, 같은 날 몇 시간만 이 브랜치에 있던 중간 checkpoint 형식의 reader가 현재 checkpoint의 overflow를 두 번 세는 문제(R6)는 그 reader가 배포된 적이 없어 고치지 않았다.
- **비용 추정 정가표**: OpenAI·Gemini·Anthropic 공식 가격 페이지에서 2026-10-23에 읽은 값(정확한 모델 ID만, 120일 지나면 unknown, 제공사 목록 가격 우선, Comet·Custom 제외). Sol이 35개 값을 공식 페이지와 다시 대조해 불일치 0. 같은 검토에서 찾은 기존 결함(카탈로그 가격 Infinity/overflow가 $0 추정이 됨)을 고쳤다.
- **용어집 성능(U21)**: 편집한 줄만 다시 계산하고 200개를 넘으면 화면 밖 줄 layout을 미룬다(Chrome 4배 CPU 제한 2,000개: 입력 약 330→47 ms, "더 보기" 약 970→430 ms). 화면 읽기 프로그램 탐색 모드 영향은 U23으로 남겼다.
- **문서·도움말**: ko/en/ja 소개 화면 9장 재캡처와 4개 언어 사용 안내 갱신(U13·U14), 도움말에 CometAPI 키 발급 페이지(U19).
- **Windows native 확인(서명 없음, 공개하지 않음)**: `cd263f2`와 검토 수정 뒤 `b0ac487`에서 각각 `pnpm desktop:build`(PyInstaller 6.16.0 sidecar 시작 확인 `system.hello`, release build, NSIS 설치 파일 18 MB) PASS. 두 build 모두 설치하지 않은 release 실행 파일로 두 번씩 실행: 코어가 Job 아래에서 시작해 `app.bootstrap`·`worlds.discover` 응답, 창 닫기(WM_CLOSE)로 종료 코드 0·sidecar 0개, 강제 종료(`taskkill /F`)에서도 sidecar와 그 자식까지 사라짐. 실행이 만든 앱 데이터 폴더(이전에 없던 두 곳)는 확인 후 지웠다. 설치 프로그램 실행·화면 조작(X 확인 창, Alt+F4, 저장 창)·키체인은 하지 않았다.

- **두 번째 묶음의 자동 검사**: `fa3a2a6`에서 `pnpm verify:local` 60/60 PASS. 같은 소스의 전체 Playwright는 314 PASS·2 실패였고, 두 실패는 부하에 따른 테스트 타이밍(멈춘 종료의 대기 상태 150 ms, 5.2초 뒤 사라지는 알림)이라 테스트를 고쳐 반복 실행으로 확인했다. 최종 소스 `b0ac487`에서 전체 Playwright 316/316 PASS(2 workers, 26.9분).

- **Windows native 추가 확인(`b0ac487` build)**:
  - 실제 packaged core 대상 Rust smoke 5/5 PASS(`cargo test --lib smoke_ -- --ignored`, 합성 월드 복사본): 시작·`system.hello`·`app.bootstrap` 599 ms, 합성 월드 scan 후보 3·파일 SHA-256 불변, 실행 중 scan 취소 marker와 작업 종료, 멈춘 core 강제 종료 2.0초, 그리고 orphan 확인 — 정지(suspend)시킨 core를 띄운 부모를 `taskkill /F`로 죽이자 core가 Job Object로 사라졌다.
  - NSIS 설치 파일을 사용자 범위로 조용히 설치(`/S`, 종료 코드 0) → `%LOCALAPPDATA%\PomiTranslate`에 실행 파일·`pomi-sidecar`·제거 프로그램, 제거 정보(0.1.0)·시작 메뉴 바로가기 등록 → 설치된 앱이 설치 폴더의 core로 시작, 창 닫기 종료 코드 0·core 잔류 없음 → 조용한 제거(종료 코드 0)로 프로그램 폴더·제거 정보·바로가기가 사라지고 앱 데이터는 남음(설계대로). 제거 뒤 Tauri NSIS가 설치 경로만 적어 둔 `HKCU\Software\PomiTranslate contributors\PomiTranslate` 키가 남는다(낮음, 템플릿 기본 동작; 이번 확인에서 만든 것은 지웠다). 확인 전에 없던 앱 데이터 폴더도 지웠다.
  - 실제 Windows 자격 증명 관리자: 앱의 `OsKeychain`으로 `PomiTranslate/native-check-<pid>`에 더미 값(한글 포함) 쓰기→읽기→덮어쓰기→삭제→없음 확인→다시 삭제 성공 PASS, `cmdkey` 잔류 0(`cargo test --lib os_keychain_round_trip -- --ignored`, 기본 실행에서는 건너뜀). 앱 화면에서 키체인 방식을 고르는 흐름과 권한 창은 확인하지 않았다.
  - 하지 않은 것: 설치 프로그램 화면(언어·경로) 조작, 이전 버전 위 업데이트 설치, 앱 안 클릭(X 확인 창·Alt+F4·저장 창).

## 8. 남은 증거 (이 문서 시점)

- 실제 Windows 창에서 X·Alt+F4·Ctrl+Q 종료 흐름, 설치 프로그램 빌드·설치, 패키지된 sidecar(콘솔/비콘솔)의 JSONL.
- macOS/Linux: Unix 코드 경로 컴파일·실행, `lockf`·디렉터리 fsync·F_FULLFSYNC, 키 폴더 권한 검사, 프로세스 그룹 종료, Java/Minecraft 실행 중 잠금 상호 작용.
- 실제 OS keychain 권한 흐름, 서명된 업데이트·설치, clean machine.
- 실제 제공사로 용어집·서식 잔여 재시도 확인.
- 전원 차단 내구성은 주장하지 않는다.
