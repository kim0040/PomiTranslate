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
  - release 실행 파일 창을 Windows UI Automation으로 조작(사람 클릭 대신 접근성 API의 버튼 실행·값 입력, 창 닫기는 X·Alt+F4와 같은 `WM_CLOSE`): 첫 실행 주의 사항 수락→시작 안내 건너뛰기→환경 설정에서 "추가 번역 지시 사항" 수정("저장하지 않은 변경사항" 표시)→창 닫기 요청에 앱이 닫히지 않고 "저장하지 않은 설정이 있습니다" 창(취소·저장하지 않고 종료·저장하고 종료)을 띄움. 취소는 앱과 입력값 유지, "저장하지 않고 종료"는 종료 코드 0·core 잔류 없음·설정 파일에 값 없음, 재실행 시 첫 실행 안내 없음·입력란 빈 값, "저장하고 종료"는 `%APPDATA%\PomiTranslate\settings.json`과 백업에 값 기록. 같은 흐름을 이어서 14회 반복해 모두 첫 닫기 요청에서 약 0.1초 안에 확인 창이 떴다. 그보다 앞선 자동화 실행 2회는 첫 요청 뒤 확인 창이 보이지 않아 두 번째 요청에서 떴다(앱은 닫히지 않음). 원인은 7f에서 찾았다: 자동화가 쓴 .NET `Process.MainWindowHandle`이 앱 창이 아니라 single-instance plugin의 숨은 16×16 창(`app.pomitranslate.desktop-siw`)을 가리킬 때가 있고, 그 창에 보낸 `WM_CLOSE`는 그 창만 없앤다(앱 결함 아님). 확인 뒤 테스트가 만든 설정 파일과 앱 데이터 폴더를 지웠다(기존 `locks`는 그대로).
  - 하지 않은 것: 설치 프로그램 화면(언어·경로) 조작, 이전 버전 위 업데이트 설치, 사람의 실제 마우스·키보드 조작과 화면 낭독기, 작업 실행 중 닫기(작업 확인 창).

## 7f. 세 번째 묶음 — 실제 앱 흐름, Linux 실행, 취소 지연

### Windows release 앱으로 한 확인(UI Automation, 유료 호출 없음)

- **번역 흐름 전체**: 합성 월드 복사본(baseline SHA-256 기록)을 두 번째 실행 인자로 열고 스캔(고유 문자열 3개·위치 3곳·요청 1회) → 후보 검토에서 1개에 직접 번역 입력 → 번역 시작. 제공사는 127.0.0.1의 OpenAI 호환 대역 서버(받은 문자열에 `[번역] `을 붙여 돌려줌, 키는 비교만 하고 기록하지 않음)로, 사용자 지정 엔드포인트·더미 키·로컬 암호화 저장 방식을 썼다. 결과: 4초에 완료, 서버는 요청 1회에 2개 문자열만 받았고(직접 번역은 보내지 않음) 키가 일치했다. 월드에는 제공사 번역 2개와 직접 번역 1개가 들어갔고, 슬롯이 커진 청크는 새 `.mcc`로 옮겨졌다. 백업 관리에서 복원하자 모든 원본 파일이 baseline SHA-256과 같아지고 번역이 만든 `.mcc`는 사라졌다. 스캔·검토 동안 월드는 바뀌지 않았다.
- **월드에 남는 잠금 파일**: 번역을 한 번 적용하면 `<world>/.pomi-translate/write.lock`(빈 파일)이 복원 뒤에도 남는다. `mwt/locking.py`의 설계(지우거나 바꾸지 않는 OS 잠금 파일)대로이며 사용자 문서에 없어서 4개 언어 사용 안내의 복원 절에 적었다.
- **OS 키체인 방식(화면 흐름)**: 환경 설정 → 키 관리 및 보안 → OS 키체인 선택 후 저장 전에는 OS 저장소 호출 0번, 저장하자 Windows 자격 증명 관리자에 `custom.PomiTranslate` 1개가 생기고 모델 목록 요청이 키체인에서 읽은 더미 키로 대역 서버에 도착(일치). 앱 데이터 파일 472개 어디에도 더미 키 평문 없음. 재시작 뒤 "API 키 저장됨 · OS 키체인"이 유지되고, 키는 모델 목록을 누를 때만 쓰였다. "저장된 키 삭제" 확인 창으로 지우자 자격 증명 0개.
- **작업 중 닫기**: 번역 요청이 진행 중일 때 창을 닫으면 "작업 중에 종료할까요?"(계속 작업·작업을 취소하고 종료). 계속 작업은 작업을 유지했다. 제공사가 20초 뒤 답하는 동안 취소하면 답을 받은 뒤 쓰지 않고 종료(월드 SHA-256 불변, core 잔류 없음). 60초 지연에서는 30초 안에 멈추지 못해 "작업이 멈추지 않았습니다"(계속 기다리기·지금 종료)가 뜨고, 지금 종료는 3.2초 만에 core까지 끝냈으며 월드는 바뀌지 않았다. 25초 지연에서 취소가 쓰기 직후에 도착한 실행은 그대로 완료됐고(쓰기 단계는 파일·단위마다 취소를 확인한다), 백업으로 복원해 baseline으로 되돌렸다.
- **접근성 이름**: 시작 안내와 6개 화면(번역 작업·백업 관리·용어집·환경 설정·도움말·정보)에서 보이는 대화형 컨트롤 107개 모두 UI Automation 이름이 있었다(이름 없는 버튼·입력 0). 화면 낭독기 자체로 들어 본 것은 아니다(U23).

### 취소가 제공사의 답을 기다리던 문제 (수정)

`stop_guard`는 요청을 보내기 전에만 확인했기 때문에, 이미 보낸 요청은 답이 오거나 `request_timeout`(기본 120초)이 지날 때까지 기다렸다. 그래서 느린 모델에서는 "작업을 취소하고 종료"가 30초 대기를 넘겨 "작업이 멈추지 않았습니다"로 갔고, 화면의 취소도 그만큼 늦었다.

플랫폼 차이를 직접 확인했다(Python 3.12 probe): Windows에서는 다른 스레드의 `shutdown`이 막힌 `recv`를 깨우지 않고(socket timeout까지 대기) handle을 닫아야 깨우며, Linux는 반대로 `shutdown`에 EOF로 깨고 `close`로는 깨지 않는다. 같은 이유로 기존 전체 시간 제한 타이머도 Windows에서는 막힌 읽기를 깨우지 못하고 있었다.

첫 구현은 감시 스레드가 stop 플래그를 보고 소켓을 `shutdown`하고 Windows에서는 handle도 닫았다. Sonnet 검토(High 1·Medium 2)에서 다른 스레드가 handle을 닫으면 Windows가 그 번호를 새 소켓에 주고, 막혀 있던 TLS 읽기가 깨어나 남의 연결 바이트를 읽을 수 있음이 실험으로 드러났다(연결이 많이 생기고 닫히는 조건에서 정지의 약 0.2~0.4%, 정상 TLS 요청이 깨짐). 또 TLS handshake 중의 정지는 감시를 끝내 버려 `request_timeout`까지 기다렸고, 플래그가 바뀐 뒤 0.2초 안에 온 오류는 제공사 실패로 집계됐다.

두 번째 구현은 다른 스레드가 handle을 닫지 않고, 연결된 소켓의 읽기가 최대 0.2초씩 기다리며 사이마다 플래그와 전체 시간을 보게 했다. Sol 검토(High 2·Medium 1)가 다시 세 가지를 찾았다: 바이트를 조금씩 계속 보내는 서버는 대기 시간 초과가 없어 정지를 시간 제한까지 미뤘고, 정지 뒤 깨진 답(잘못된 JSON·잘린 본문)은 여전히 제공사 실패로 집계됐으며(실제 `BatchTranslator`에서 연속 실패 1·오류 이벤트), 프록시 CONNECT 응답과 그 뒤 TLS handshake는 Windows에서 시간 제한을 넘겼다(2초 제한에 3.4·3.6초, 변경 전부터 있던 문제).

최종 구현:

- **다른 스레드는 소켓에 닿지 않는다.** 시간 제한 타이머와 그 `shutdown`도 없앴다. 이름 조회(버리는 스레드)와 TCP 연결은 남은 시간으로, 그 뒤의 모든 대기(프록시 CONNECT 응답, TLS handshake, 응답 읽기)는 소켓을 쥔 스레드에서 최대 0.2초씩 기다리며 사이마다 전체 시간과 stop 플래그를 본다. 읽기는 소켓 class를 필드를 더하지 않는 subclass로 바꿔(`_polling`) http.client가 쥔 객체 그대로 감싸고, handshake는 연결의 TLS context가 `do_handshake_on_connect=False`로 감싼 뒤 시간이 초과된 `do_handshake`를 이어서 부른다(`_HandshakeOnTime`). 보내기(`sendall`)도 같은 방식으로 나눠, 시간이 초과된 쓰기는 같은 바이트로 다시 부른다(TLS 쓰기가 요구하는 방식; CPython은 OpenSSL의 moving write buffer 모드를 켠다).
- **정지는 바이트가 오는 동안에도 0.2초마다 본다.** 본 뒤에는 이미 오고 있는 답에 0.5초를 주고(이미 도착한 답은 그대로 쓴다), 아무것도 오지 않는 대기는 바로 끝낸다. 결과는 `RequestStopped`(호출부가 취소로 처리하는 예외).
- **정지 뒤의 실패는 정지다.** `_request_json`은 전송 오류·HTTP 오류·잘린 본문·잘못된 JSON을 한 곳에서 분류하기 전에 플래그를 다시 읽고, `complete_text`는 정지 뒤 어떤 예외도 `RequestStopped`로 바꾸며, 번역기의 두 `except Exception`은 실패를 집계·청구·보고하기 전에 작업 정지를 확인한다. 보낸 요청 1회의 예산만 남는다.
- 모델 목록 GET은 플래그를 보지 않지만 같은 시간 제한을 받는다.

확인(Windows, 유료 호출 없음): Sol의 probe에서 정지 뒤 헤더·본문·chunked·오류 본문이 조금씩 오는 경우 0.5~0.75초에 정지(전에는 시간 제한까지), 잘못된 JSON·잘린 본문은 정지, 번역기 연속 실패 0·오류 이벤트 없음, 프록시 두 경우 2초 제한에 2.0·2.03초, TLS 1.2/1.3 읽기를 레코드 중간에서 끊었다가 이어도 28,000바이트 SHA-256 일치, 소켓·guard·class 누수 없음, 정지·정상 TLS 요청 160개 동시 실행에 틀린 결과 0. 첫 구현에서 정상 TLS 요청을 깨뜨린 연결 교체 실험(정지 요청 6개와 정상 요청 6개를 30초씩)은 handle을 닫지 않는 두 번째 구현에서 2회 실행해 정상 10,637건 중 실패 0이었다. 회귀 테스트는 서버가 요청을 받은 시점부터 잰다: 답을 기다리는 중·헤더 조금씩·본문 조금씩·오류 본문 멈춤·잘못된 JSON·잘린 본문·HTTP 500·choices 없는 답에서 정지 뒤 0~0.52초에 `RequestStopped`(request_timeout 30), 정지 직전 도착한 답 유지, 프록시 두 경우, 번역기에서 정지 뒤 실패(일시·알 수 없음·속도 제한)가 재시도·집계·청구·오류 이벤트 없이 취소로 끝남. 새 테스트는 HEAD 코드에서 실패한다.

Sol 후속 검토는 세 결과의 수정을 확인했고(Python 3.11/3.12/3.13, TLS 1.2/1.3에서 handshake 재개·인증서 오류가 HEAD와 같은 분류·실패한 handshake의 handle 정리) 하나(Medium)를 더 찾았다: 받는 쪽이 읽기를 멈춘 큰 TLS 업로드는 `sendall`이 정지를 보지 않아 시간 제한까지 갔다(3초 제한, 정지 뒤 2.78초). 보내기도 나눠 기다리게 한 뒤 같은 probe(32 MiB 본문)에서 정지 뒤 0.20초, 정지 없이는 3초에 시간 초과. Windows는 평문 소켓에 큰 본문도 바로 받아 두므로 테스트는 `send`가 자리를 얻지 못하는 socket subclass로 정지(0.3초)·시간 제한·조금씩 받는 `send`의 바이트 순서를 확인한다.

한 작업자가 `ProviderUnavailable`로 작업을 멈추면 같은 작업의 다른 진행 중 요청도 이제 바로 끊긴다(전에는 답을 받아 기록했다). 작업 결과는 같고, 그 요청의 비용은 발생했지만 답은 버려진다.

수정한 core로 sidecar와 앱을 다시 빌드해(`pnpm desktop:build`, clean) 같은 60초 지연 시나리오를 반복했다. 첫 구현에서 번역 시작 9.4초 뒤 창을 닫고 "작업을 취소하고 종료"를 누르자 5.1초 만에 앱이 종료됐고(이전에는 30초 동안 끝나지 않아 "작업이 멈추지 않았습니다"), 대역 서버 기록으로 그 요청(문자열 3개)이 취소 시점에 이미 보내져 답을 기다리던 중이었음을 확인했다. 최종 구현의 build(core 23:15, 앱 23:22)에서도 "작업 중에 종료할까요?"가 첫 닫기 요청에 뜨고 취소 뒤 5초에 종료, core 잔류 0, 월드 SHA-256 불변.

그 5초를 나눠 보니 번역 core는 클릭 2.3초 뒤 끝났고, 나머지는 작업이 끝나며 화면이 보낸 새로고침(`backups.list`·`resume.status`·`candidates.page`·`estimate.get`·`review.draft.get`)이 core를 하나씩 5번 새로 띄운 시간이었다. 종료를 확정한 뒤 대기 중에는 shell이 새 core 요청을 `APP_QUITTING`으로 거절하고(3개 언어 문구 있음), 화면은 그 대기 단계의 오류를 띄우지 않는다. 다시 빌드한 앱(23:41)에서 같은 시나리오: 클릭 2.5초 뒤 종료, 그 사이 새 core 0개, core 잔류 0, 월드 불변, 기록에는 거절된 `backups.list` 1건.

작업 뒤 앱이 창 없이 남은 것처럼 보인 1회(번역→복원→백업 화면에서 닫기)는 같은 순서를 다시 해도 15초 안에 정상 종료돼 재현되지 않았다. 코드에서 맞는 경로를 찾아 고쳤다: 창 닫기(`CloseRequested`)가 허용돼도 그 결정을 기록하지 않아, 창이 사라진 뒤 마지막 창이 닫혀 오는 `ExitRequested`에서 다시 판단했고, 그 사이 화면이 새로고침 요청(백업 화면의 `backups.list` 등)을 시작했으면 "작업 중"으로 보고 이미 없는 창에 질문을 보낸 채 종료를 막았다(남은 것은 plugin 창뿐, core·WebView 없음 — 관찰과 일치). 이제 허용된 창 닫기는 확정으로 기록하고(`allow_window_close`), 질문할 창이 없으면 종료를 막지 않는다(`held`, 단위 테스트). 수정 build에서 백업 화면을 연 뒤 40~200 ms 사이에 닫기 5회 모두 종료, 깨끗한 닫기·저장하지 않은 설정 확인 창도 그대로였다. 수 ms 틈의 경쟁이라 수정 전 동작을 일부러 재현하지는 못했다. Sol 검토가 남은 틈을 지적했다: 한가할 때 닫기가 허용된 뒤 이미 오던 요청(예: 번역 시작 전의 설정 저장 다음 단계)이 시작되면 종료가 질문 없이 core를 끝낸다. 이제 닫기·종료 판단은 먼저 새 요청 접수를 막고(`closing`) 바쁜지 본다: 이미 요청 gate를 쥔 요청은 바쁨으로 보여 질문이 뜨고, 그 뒤에 gate를 쥔 요청은 gate를 쥔 채 다시 확인해 `APP_QUITTING`으로 거절된다. 질문으로 닫기를 멈추면 접수를 다시 연다. 종료가 확정된(`confirmed`) 뒤에도 접수하지 않는다(단위 테스트). 이 자동화는 `MainWindowHandle`이 plugin 창을 가리킬 수 있어(위 7e) 이후 확인은 `Tauri Window` class의 창을 찾아 닫기를 보낸다; plugin 창에 닫기를 보내면 그 창만 사라지고 앱은 계속 실행된다(사람의 조작으로는 닿지 않는 숨은 창이다).

세 번째 묶음의 최종 소스(취소·`APP_QUITTING`·Linux 이식성 수정 포함)에서 `pnpm verify:local` 60/60 PASS(656초).

### 설치·제거 화면과 메뉴 종료 (Windows, UI Automation)

- **설치 화면**: 설치 파일을 대화형으로 실행해 시작 → 사용권(앱의 MIT License) → 설치 위치(기본 `%LOCALAPPDATA%\PomiTranslate`, 48 MB) → 설치 → 완료(“PomiTranslate 실행하기”·“바탕화면 바로가기 만들기” 기본 선택)를 한국어로 진행했다. 마침을 누르자 설치된 앱이 실행돼 설치 폴더의 core로 `app.bootstrap`·`worlds.discover`에 답했고, 바탕화면·시작 메뉴 바로가기와 제거 정보(0.1.0, 게시자 PomiTranslate contributors)가 생겼다. 한글·공백이 있는 경로(`…\설치 테스트\Pomi 앱`, `/S /D=`)에서도 설치·실행·core 응답이 정상이었다.
- **제거 시 언어 질문 (수정)**: `displayLanguageSelector: false`인 설치는 언어를 저장하지 않아, 제거 프로그램이 매번 영어로 “Please select a language”를 먼저 물었다(처음 확인 때는 예전 설치가 남긴 registry 값 때문에 보이지 않았다). `src-tauri/windows/hooks.nsh`의 설치 후 hook이 고른 언어를 저장한다. 다시 빌드한 설치 파일로 조용히 설치하자 값 1042(한국어)가 기록되고 제거 프로그램이 바로 한국어 제거 화면을 띄웠다.
- **“애플리케이션 데이터 삭제하기” (수정)**: 기본 해제. 선택하면 Tauri 기본 동작은 shell 폴더(`%APPDATA%`/`%LOCALAPPDATA%\app.pomitranslate.desktop`: 키 DB·키 파일·보고서·로그·WebView)만 지워, core 폴더의 설정·이어서 할 작업·스캔이 남았다(수정 전 build에서 확인). 첫 수정은 NSIS hook이 초기화 목록을 직접 `Delete`/`RMDir /r`했고 설치·제거로 확인했다(설정·`jobs`·`scans`·`models` 삭제, 최상위 junction은 링크만 삭제, 백업·카운터·손상 사본·잠금 유지). Sol 검토(High 1·Medium 2)가 세 문제를 찾았다: NSIS 3.11의 `RMDir /r`은 하위의 junction을 따라가므로(`jobs
ested`→`backups` 실험에서 백업 journal 삭제) 최상위 검사로는 막지 못하고, 다른 identifier의 평가 build를 제거하면 제품 core 폴더를 지우며, 허용된 닫기와 새 core 요청 사이에 틈이 있었다(아래). 최종 설계: 제거 hook은 아무 것도 직접 지우지 않고, 제품 identifier·상자 선택·업데이트 아님·폴더와 core 존재일 때만 제거 직전에 설치된 core의 `--reset-user-data`를 실행한다(앱 안 초기화와 같은 코드). 같은 실험에서 core 초기화 자체도 Windows junction에 결함이 있었다: 최상위 폴더가 junction이면 `shutil.rmtree`가 "Cannot call rmtree on a symbolic link"로 멈춰 초기화가 반쯤(설정만 지워진 채) 끝났다. 초기화는 이제 심볼릭 링크와 junction을 어느 깊이에서든 링크로만 지운다(`_remove`, 테스트는 수정 전 실패). hook 테스트는 guard와 core 호출, 그리고 `--reset-user-data`가 백업을 남기고 초기화 항목을 지우는지 확인한다. Sol 재검토(High 1·Medium 2·Low 1): reset이 템플릿의 실행 중 앱 확인보다 먼저 돌아, 그 질문에서 취소하면 제거는 멈췄는데 데이터는 이미 지워졌다 → hook이 같은 확인(`CheckIfAppIsRunning`)을 먼저 실행한다. 링크 판정을 junction만이 아니라 다른 곳을 가리키는 모든 reparse point(name surrogate)로 넓혔고, 데이터 폴더 자체가 링크인 경우와 실행 중 다른 프로그램이 구조를 바꾸는 경우의 범위를 문서에 정확히 적었다. 지우지 못한 항목이 있으면 나머지를 계속 지우고 남은 것을 오류로 알리며(테스트), 제거 프로그램은 3개 언어 경고로 폴더 위치를 알려 준다. 시스템 종료(`ExitRequested`)도 닫기와 같이 접수를 먼저 막고, 확인된 종료는 `waiting`을 풀기 전에 `confirmed`를 세운다. Windows 실제 설치본(clean sidecar+app build)으로 확인: 앱 실행 중 상자 선택 후 제거 → 실행 중 질문이 뜨는 동안 데이터 그대로, 취소 → 데이터·앱·설치 모두 그대로. 확인 → 앱 종료, 읽기 전용 checkpoint 하나만 남고 설정·스캔·모델 삭제, 한국어 경고(폴더 위치 포함), 제거 완료(프로그램·등록 정보·shell 폴더 삭제, 백업 유지). 그 전 build에서 중첩 junction(`jobs
ested`→`backups`)과 최상위 junction(`scans`→바깥)도 대상이 남았다. Sol 3차 확인: 실행 중 확인은 닫힘, “계속 기다리기”가 대기 시간 초과 뒤 한가한 상태를 본 순간과 종료 사이에 요청을 받을 수 있었음 → 보기 전에 `waiting`을 먼저 잡는다. 앱 안 초기화가 일부만 지워지면 일반 오류(“결과의 변경 파일…”)와 “초기화되지 않았습니다”가 나왔음 → core가 `RESET_INCOMPLETE`(남은 최상위 항목 이름 포함)로 답하고, 앱은 3개 언어로 무엇이 남을 수 있는지와 이미 지워진 키·보고서를 말한다(테스트).
- **메뉴 종료**: Windows 메뉴 막대의 파일 → “PomiTranslate 종료 Ctrl+Q”(id 1050)와 “창 닫기 Alt+F4”(1049)를 메뉴가 보내는 `WM_COMMAND`로 실행했다(잠긴 화면이라 실제 키 입력은 보내지 못했다). 저장하지 않은 설정이 있으면 둘 다 확인 창을 띄우고, 취소는 앱과 입력값을 유지, “저장하지 않고 종료”는 core 잔류 없이 종료하고 값을 쓰지 않았다. 아무 것도 없으면 0.16초에 종료 코드 0. 메뉴 종료는 창 닫기와 같은 `allow_close`를 거치므로 작업 중 확인은 위 창 닫기 확인과 같은 경로다.
- **업데이트 확인 로그**: 공개 피드가 없는 build는 시작할 때마다 `ERROR update_check UPDATE_NOT_PUBLISHED`를 남겨 진단 복사의 최근 오류에 들어갔다. 이제 INFO(“no release feed is published”)로 남기고 화면에는 같은 코드를 준다.

### Linux 실행 (Docker, 처음)

- **Python core 51개 파일**: `python:3.12-slim`에서 `git archive` 소스로 실행. 처음 47 PASS·4 FAIL이었고 원인은 다음과 같다.
  - 제품 결함 1: 전체 시간 제한이 소켓을 끊으면 Linux의 읽기는 오류가 아니라 EOF로 끝나 일부만 받은 본문을 완성으로 넘겼고, 시간 초과가 "invalid JSON"/`NETWORK_ERROR`로 보고됐다. EOF 때 guard가 만료됐으면 시간 초과로 처리한다(오류 본문 읽기도 같은 guard를 쓴다).
  - 테스트 이식성 3: fsync 감시가 POSIX 디렉터리 flush(읽기 전용 descriptor)를 읽기 전용 파일 handle로 오인, Linux에 `lsof`가 없으면 리스너 확인이 중단(→ `/proc` 대체와 양성 대조), 이전 coverage reader를 `git show 9add4d8:`로 읽어 얕은 clone(CI의 `actions/checkout` 기본값)이나 소스 묶음에서 실패(→ fixture 파일).
  - 수정 뒤 51/51 PASS. 취소 최종 구현 뒤의 소스로 다시 51/51 PASS.
- **Rust**(Sonnet 작업자, Ubuntu 24.04 이미지, rustc 1.98.1): `cargo test --lib` 236 PASS·2 FAIL·6 ignored, clippy 경고 0. 두 실패는 테스트 도우미 `process_alive`가 `kill(pid, 0)`만 봐서 회수되지 않은 zombie를 살아 있다고 본 것이었다(제품 동작은 의도대로: 대기 실패 뒤 다시 죽이고 슬롯을 점유한 채 상태 Unknown). Linux는 `/proc/<pid>/stat`, 그 밖의 Unix는 `ps`로 zombie를 끝난 것으로 본다. 수정 뒤 238 PASS·0 FAIL·6 ignored.
- **Linux Secret Service**: keyring 4.2.0은 Linux에서 zbus Secret Service를 쓴다. 컨테이너 안 비공개 D-Bus 세션의 gnome-keyring 46.1(비밀번호로 잠금 해제한 login keyring)에서 `os_keychain_round_trip` PASS. login keyring이 없으면 쓰기가 `KEYCHAIN_FAILED`, D-Bus 세션이 없으면 첫 읽기가 `KEYCHAIN_UNAVAILABLE`(설계대로, 멈춤 없음).
- **패키지·창(Sonnet 작업자, `fd34b3b` 소스)**: Ubuntu 24.04 컨테이너에서 clean sidecar(PyInstaller 6.16.0, 41.8 MiB)와 `pnpm tauri build`로 deb 27.9 MB·AppImage 101.9 MB(SHA-256 기록, `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`). 새 `ubuntu:24.04`에 deb만 설치(277개 패키지가 선언된 의존성으로 해결, `ldd` 누락 없음)하고 일반 사용자·Xvfb에서 실행: 약 1초에 창, 첫 실행 주의 사항 화면과 native 메뉴, core가 `app.bootstrap`·`worlds.discover`에 답함. openbox `wmctrl -ic`·맨 Xvfb의 `WM_DELETE_WINDOW` 닫기 모두 종료 코드 0, 0.11~0.27초, core 잔류 0. AppImage(`--appimage-extract-and-run`)도 같은 결과. 앱을 `kill -9`하면 실행 중이던 core가 0.06~0.14초 안에 사라졌다(`PR_SET_PDEATHSIG`). packaged core smoke는 scan·scan 취소·멈춘 core 강제 종료(2.0초) PASS, 정지시킨 core의 부모를 `kill -9`하자 core가 1초 안에 사라짐(orphan 없음), 합성 월드 SHA-256 불변.
  - smoke `smoke_spawn_hello_and_bootstrap`은 Linux에서 실패했다: 테스트가 `app.bootstrap`을 `credentialOwner` 없이 보내 core가 OS keyring을 읽었고, Secret Service가 없는 컨테이너에서 `NoKeyringError`. 앱은 그런 요청을 보내지 않는다(shell이 `CREDENTIAL_OWNER_REQUESTS`에 항상 `credentialOwner: rust`를 붙이고, core의 keyring 경로 8곳을 대조함; dry-run scan은 키를 읽지 않음). Windows에서 통과한 것은 자격 증명 관리자가 있어서였다. smoke 요청에 `credentialOwner: rust`를 붙였고, core의 `load_api_key`는 keyring backend가 아예 없으면 "저장된 키 없음"으로 본다(다른 keyring 오류는 그대로; 테스트는 수정 전 실패).
  - deb에 CJK 글꼴 의존성이 없어 글꼴 없는 시스템에서 한국어·일본어가 네모로 보였다(컨테이너 확인). deb에 `Recommends: fonts-noto-cjk`를 더했다(Tauri `bundle.linux.deb.recommends`). AppImage는 시스템 글꼴에 의존한다.
- 하지 않은 것: 실제 Linux 데스크톱 세션(GNOME/KDE·Wayland·GPU·HiDPI·파일 대화상자·portal), 그 위의 Secret Service 키 흐름, Linux에서 실제 번역 흐름, 수정 뒤 소스의 Linux 패키지 재build, macOS.

### Minecraft 실제 로드(COMP-04)

이 PC의 `%APPDATA%\.minecraft`에는 실행한 적 없는 Forge 1.18.2 서버 설치(`eula.txt`·월드 없음)만 있다. 실행하려면 사용자를 대신해 Minecraft EULA에 동의해야 하고, 앱의 주 대상(1.21.x)과 형식도 달라서 시도하지 않았다.

## 8. 남은 증거 (이 문서 시점)

7e·7f에서 Windows의 설치·실행·제거, 창 닫기 확인 창(접근성 API 조작), 번역·복원 흐름, 자격 증명 관리자, Linux 컨테이너의 Python·Rust 단위 검사와 Secret Service는 확인했다. 남은 것:

- 사람의 실제 마우스·키보드 조작(Ctrl+Q 실제 키 입력 포함)과 화면 낭독기(U23), 이전 버전 위 업데이트 설치.
- macOS 전체, Linux 실제 데스크톱 세션(Xvfb 확인은 함): F_FULLFSYNC, 실제 데스크톱의 키 폴더 권한·Secret Service, Java/Minecraft 실행 중 잠금 상호 작용.
- 서명된 업데이트·설치, clean machine(승인 경계).
- 실제 제공사로 용어집·서식 잔여 재시도 확인(유료 호출).
- 번역한 월드를 실제 게임에서 불러오기(COMP-04).
- 전원 차단 내구성은 주장하지 않는다.
