const STORAGE_KEY = "mc-world-translator-ui-v2";
const ACTIVE_JOB_KEY = "mc-world-translator-active-job";

// The server puts a per-launch token in the page. Every API call must carry it, so another web page
// (or a DNS-rebinding host) cannot drive this local server from the browser.
const API_TOKEN = document.querySelector('meta[name="pomi-webui-token"]')?.content || "";

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Pomi-WebUI-Token", API_TOKEN);
  return fetch(url, { ...options, headers, credentials: "same-origin" });
}

const FALLBACK_META = {
  providers: [
    { id: "openai", label: "OpenAI", default_base_url: "https://api.openai.com/v1", env_var: "OPENAI_API_KEY" },
    { id: "gemini", label: "Gemini", default_base_url: "https://generativelanguage.googleapis.com/v1beta", env_var: "GEMINI_API_KEY" },
    { id: "anthropic", label: "Anthropic", default_base_url: "https://api.anthropic.com/v1", env_var: "ANTHROPIC_API_KEY" },
    { id: "openrouter", label: "OpenRouter", default_base_url: "https://openrouter.ai/api/v1", env_var: "OPENROUTER_API_KEY" },
    { id: "comet", label: "Comet API", default_base_url: "https://api.cometapi.com/v1", env_var: "COMET_API_KEY" },
    { id: "custom_openai", label: "기타 / Custom (OpenAI 호환)", default_base_url: "https://api.openai.com/v1", env_var: "CUSTOM_OPENAI_API_KEY" },
    { id: "custom_anthropic", label: "기타 / Custom (Anthropic 호환)", default_base_url: "https://api.anthropic.com/v1", env_var: "CUSTOM_ANTHROPIC_API_KEY" },
  ],
  style_presets: ["neutral", "casual", "formal", "polite", "story", "custom"],
  example_paths: { world_dir: "", translate_py_path: "" },
  defaults: {
    provider: "comet",
    batch_size: 40,
    temperature: 0.3,
    backup_suffix: ".bak_translate",
    request_timeout: 120,
    region_dirs: ["region", "entities", "DIM-1/region", "DIM-1/entities"],
    skip_patterns: ["*.bak_translate"],
    resource_pack_source_lang_files: ["en_us.json", "zh_cn.json"],
  },
};

const TARGET_LANGUAGE_VALUES = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
};

const I18N = {
  ko: {
    skipToContent: "본문으로 건너뛰기",
    brandKicker: "World Translator for Minecraft",
    brandTitle: "PomiTranslate",
    brandCopy:
      "AI 제공사, 모델, 프롬프트, 스캔 범위, 리소스팩, 진행 상태를 한눈에 관리합니다. 먼저 안전하게 스캔하여 후보를 확인한 뒤 실제 번역을 진행하세요.",
    heroKicker: "Minecraft Localization",
    heroTitle: "마인크래프트 월드와 모드팩을\n원하는 언어로 완벽하게 번역하세요",
    heroText:
      "단순한 텍스트 번역을 넘어 명령어, NBT 데이터, 그리고 리소스팩까지 안전하게 처리합니다. 다양한 AI를 활용해 고유명사와 말투를 유지하며 몰입감 있는 게임 환경을 만들어보세요.",
    providerCustom: "기타 / Custom",
    fieldCustomFormat: "API 형식",
    optCustomOpenAI: "OpenAI 호환",
    optCustomAnthropic: "Anthropic 호환",
    helpCustomFormat: "지원하려는 API 공식 규격에 맞춰 선택하세요.",
    heroPanelOneTitle: "제공사 선택",
    heroPanelOneBody: "OpenAI, Gemini, Anthropic, OpenRouter, Custom 등 다양한 AI를 선택하고 기본 URL과 모델을 유연하게 설정합니다.",
    heroPanelTwoTitle: "문체 조정",
    heroPanelTwoBody: "간단한 스타일 메모만 입력해도 게임 상황에 최적화된 구체적인 번역 지침으로 확장할 수 있습니다.",
    heroPanelThreeTitle: "실시간 모니터링",
    heroPanelThreeBody: "처리 파일 수, 번역 배치, 현재 작업 파일, 갱신 시각을 실시간으로 확인하여 진행 상황을 명확히 파악합니다.",
    connectionKicker: "Step 1",
    connectionTitle: "연결 및 모델 설정",
    connectionCopy: "사용할 AI 제공사와 모델, 월드 경로를 지정합니다. 모델 목록 불러오기를 통해 사용 가능한 모델을 손쉽게 선택할 수 있습니다.",
    connectionTag: "필수 설정",
    fieldWorldDir: "월드 폴더 경로",
    helpWorldDir: "region, entities, resources.zip 등이 포함된 마인크래프트 월드 폴더를 지정합니다.",
    fieldReportPath: "결과 리포트 저장 경로",
    helpReportPath: "비워두면 월드 폴더 내 `translation_report.json`으로 저장됩니다.",
    fieldTranslatePy: "translate.py 경로",
    helpTranslatePy: "기존 translate.py에서 설정된 API 키, URL, 모델, 시스템 프롬프트를 상속할 원본 파일입니다.",
    fieldInheritTranslatePy: "translate.py 설정 상속",
    helpInheritTranslatePy: "비어 있는 API 설정 항목을 translate.py 값으로 채웁니다.",
    fieldApiKey: "API 키",
    helpApiKey: "현재 세션 메모리에서만 사용되며 브라우저 저장소나 파일에는 저장되지 않습니다.",
    fieldBaseUrl: "API Base URL",
    fieldModel: "모델 이름 (ID)",
    helpModel: "모델 ID를 직접 입력하거나 아래 목록에서 클릭하여 자동 입력할 수 있습니다.",
    fieldTimeout: "요청 제한 시간(초)",
    helpTimeout: "응답 시간이 긴 모델을 사용할 경우 충분한 시간(예: 120초 이상)으로 설정하세요.",
    baseUrlHelp: "기본 URL: {url} · 환경변수: {env}",
    actionLoadModels: "모델 목록 불러오기",
    modelCatalogIdle: "아직 모델 목록을 조회하지 않았습니다.",
    modelCatalogLoading: "모델 목록을 불러오는 중입니다…",
    modelCatalogLoaded: "{count}개의 모델을 불러왔습니다. 클릭하면 모델 입력창에 채워집니다.",
    modelCatalogError: "모델 목록 조회 실패: {message}",
    promptKicker: "Step 2",
    promptTitle: "번역 대상 언어 및 문체",
    promptCopy: "원하는 도착 언어와 문체를 설정합니다. 지시문 구체화 기능을 활용하면 간단한 메모를 전문 번역 지침으로 다듬을 수 있습니다.",
    fieldTargetLanguage: "도착 언어",
    helpTargetLanguage: "한국어, 영어, 일본어는 버튼으로 빠르게 선택할 수 있으며 직접 입력도 가능합니다.",
    fieldCustomLanguage: "직접 입력 언어명",
    helpCustomLanguage: "예: 繁體中文, Deutsch, Français, Brazilian Portuguese",
    fieldStylePreset: "기본 문체 프리셋",
    fieldStyleBrief: "추가 스타일 메모 (문체, 고유명사 등)",
    helpStyleBrief: "예: 중세 판타지 분위기, 고유명사는 원문 유지, 반말 사용 등",
    assistTitle: "AI 지시문 구체화",
    assistBody: "간단히 작성한 메모를 마인크래프트 번역에 최적화된 구체적인 시스템 지시문으로 확장합니다.",
    actionImproveStyle: "지시문 구체화",
    assistLoading: "스타일 지침을 다듬는 중입니다…",
    assistDone: "스타일 지침을 성공적으로 보강했습니다.",
    assistError: "스타일 보정 실패: {message}",
    fieldStylePrompt: "보강된 추가 스타일 지침",
    helpStylePrompt: "기본 프리셋 뒤에 덧붙여지는 세부 지시문입니다. 분위기, 고유명사 처리 원칙 등을 명시합니다.",
    customPromptToggle: "전체 시스템 프롬프트를 직접 입력하려면 열기",
    fieldCustomPrompt: "전체 시스템 프롬프트",
    helpCustomPrompt: "여기에 입력된 프롬프트가 있으면 프리셋과 추가 지침 대신 이 문장을 전적으로 사용합니다.",
    targetPreset_ko: "한국어",
    targetPreset_en: "영어",
    targetPreset_ja: "일본어",
    targetPreset_custom: "직접 입력",
    stylePreset_neutral: "표준/자연스러움",
    stylePreset_casual: "친근함/대화체",
    stylePreset_formal: "격식체/명료함",
    stylePreset_polite: "정중한 존댓말",
    stylePreset_story: "소설/이야기풍",
    stylePreset_custom: "사용자 직접 작성",
    stylePresetDesc_neutral: "표준적이고 자연스러운 문체입니다. 안내문, 퀘스트, 책 전반에 가장 무난합니다.",
    stylePresetDesc_casual: "친근한 대화형 문체입니다. 가벼운 NPC 대사나 어드벤처 맵에 어울립니다.",
    stylePresetDesc_formal: "차분하고 정돈된 문체입니다. 역사 기록물, 일지, 고풍스러운 맵에 적합합니다.",
    stylePresetDesc_polite: "플레이어에게 정중하게 안내하는 부드러운 존댓말 문체입니다.",
    stylePresetDesc_story: "판타지나 어드벤처 소설에 어울리는 수려하고 몰입감 넘치는 문체를 사용합니다.",
    stylePresetDesc_custom: "지정된 문체 없이 아래 추가 지침에 작성된 내용만으로 번역을 제어합니다.",
    scopeKicker: "Step 3",
    scopeTitle: "번역 대상 범위",
    scopeCopy: "월드 내에서 번역할 구성 요소를 선택합니다. 프리셋을 활용해 권장 구성을 빠르게 적용할 수 있습니다.",
    scopePresetRecommended: "권장 구성",
    scopePresetStory: "스토리 중심",
    scopePresetAll: "모든 항목 포함",
    scopeGroupCore: "핵심 텍스트",
    scopeGroupItems: "아이템 및 엔티티",
    scopeGroupScripted: "명령어 및 연출",
    scopeBooks: "책 페이지",
    scopeSigns: "표지판",
    scopeTitles: "타이틀 (title)",
    scopeFilteredTitles: "필터링된 타이틀 (filtered_title)",
    scopeCustomNames: "커스텀 이름",
    scopeItemNames: "아이템 이름",
    scopeLore: "아이템 설명 (Lore)",
    scopeCommandOutput: "tellraw / title 출력 텍스트",
    scopeSkipCommands: "명령어 구문 자체는 번역 건너뛰기",
    resourceKicker: "Step 4",
    resourceTitle: "리소스팩 언어 파일",
    resourceCopy: "월드 내장 리소스팩(resources.zip)의 번역이 필요한 경우 활성화합니다. 비활성화 시 리소스팩은 건드리지 않습니다.",
    fieldResourceEnabled: "리소스팩 언어 파일 번역 사용",
    fieldZipPaths: "리소스팩 zip 경로 목록",
    helpZipPaths: "한 줄에 하나씩 입력합니다. 상대 경로는 월드 폴더 기준으로 자동 계산됩니다.",
    fieldSourceLangFiles: "원본 lang 파일명",
    helpSourceLangFiles: "예: en_us.json, zh_cn.json",
    fieldTargetLangFile: "도착 lang 파일명",
    helpTargetLangFile: "예: ko_kr.json, ja_jp.json, en_us.json",
    fieldSkipExistingLang: "도착 언어 파일이 이미 존재하면 건너뛰기",
    advancedKicker: "Optional",
    advancedTitle: "고급 세부 설정",
    fieldBatchSize: "배치 크기 (Batch Size)",
    helpBatchSize: "한 번의 API 요청에 묶어 보낼 문자열 수입니다. 오류가 잦다면 크기를 줄이세요.",
    fieldTemperature: "다양성 수치 (Temperature)",
    helpTemperature: "낮을수록 일관적이고 정확한 번역을 생성합니다. 0.1~0.4 범위를 권장합니다.",
    fieldBackupSuffix: "백업 접미사 (Suffix)",
    helpBackupSuffix: "원본 파일 백업 시 붙일 확장자 접미사입니다.",
    fieldBackup: "원본 안전 백업",
    helpBackup: "월드 파일을 수정하기 전에 대상 원본 파일을 자동으로 복사하여 보존합니다.",
    fieldDryRun: "기본 실행 모드를 스캔으로 설정",
    helpDryRun: "폼 기본값을 스캔 모드로 설정하여 실수로 바로 파일이 수정되는 것을 방지합니다.",
    fieldCheckpointEnabled: "체크포인트 저장",
    helpCheckpointEnabled: "작업 중단이나 오류 발생 시 이어서 진행할 수 있도록 진행 상황을 저장합니다.",
    fieldContinueOnError: "파일 오류 발생 시 계속 진행",
    helpContinueOnError: "손상된 파일이 있어도 해당 파일만 건너뛰고 나머지 정상 파일 번역을 계속합니다.",
    fieldCheckpointPath: "체크포인트 파일 경로",
    helpCheckpointPath: "비워두면 월드 폴더 내 `.translation_checkpoint.json`으로 자동 저장됩니다.",
    fieldBatchRetries: "배치 실패 시 재시도 횟수",
    helpBatchRetries: "API 일시 오류 발생 시 요청을 재시도할 최대 횟수입니다.",
    fieldWriteRetries: "파일 저장 재시도 횟수",
    helpWriteRetries: "파일 쓰기 실패 시 원자적(Atomic) 저장으로 재시도할 횟수입니다.",
    advGroupPerf: "성능 및 API 제어",
    advGroupRecover: "백업 및 오류 복구",
    advGroupDebug: "검증 및 디버깅",
    advGroupMisc: "기타 규칙",
    fieldSkipPatterns: "스캔 제외 파일 패턴",
    helpSkipPatterns: "예: *.bak_translate",
    fieldPrefixes: "번역 키 접두사 (Translate Key Prefix)",
    helpPrefixes: "한 줄에 하나씩 입력합니다. translate 키 기반 컴포넌트를 텍스트화할 때 사용합니다.",
    fieldOverrides: "강제 텍스트 치환 규칙",
    helpOverrides: "한 줄에 `원문=번역문` 형식으로 입력합니다.",
    runKicker: "Step 5",
    runTitle: "작업 실행",
    runCopy: "먼저 '스캔만 실행'으로 번역 대상 후보를 확인한 후, 이상이 없을 때 '실제 번역 실행'으로 진행하는 것을 권장합니다.",
    actionScan: "스캔만 실행 (미리보기)",
    actionTranslate: "실제 번역 실행",
    actionResume: "이전 진행 재개",
    actionCancel: "현재 작업 중지",
    actionExport: "설정 JSON 내보내기",
    actionReset: "폼 기본값 복원",
    liveKicker: "Live Monitor",
    liveTitle: "진행 상태 모니터링",
    statusIdle: "대기 중",
    statusQueued: "대기열 진입",
    statusRunning: "작업 진행 중",
    statusCompleted: "작업 완료",
    statusCancelled: "작업 중지됨",
    statusFailed: "작업 실패",
    phaseIdle: "준비 대기",
    phaseQueued: "대기열",
    phasePreparing: "사전 준비",
    phaseResourcePack: "리소스팩 처리",
    phaseScanPending: "월드 스캔 준비",
    phaseScan: "월드 파일 스캔 중",
    phaseTranslate: "문장 번역 진행 중",
    phaseCancelled: "작업 중지됨",
    phaseDone: "모든 작업 완료",
    phaseFailed: "처리 실패",
    activityPreparing: "입력값 및 월드 경로를 검증하는 중",
    activityResourcePack: "리소스팩 zip 내 언어 파일을 처리하는 중",
    activityScanStart: "월드 파일 스캔을 시작합니다",
    activityFileStart: "파일에서 번역 대상 텍스트 후보를 수집하는 중",
    activityFileDone: "현재 파일 처리를 마쳤습니다",
    activityBatchStart: "AI 배치 번역 요청을 전송하는 중",
    activityBatchDone: "배치 번역 결과를 데이터에 반영하는 중",
    activityBatchError: "배치 오류 발생 후 작은 단위로 분할 재시도 중",
    activityResourcePackSkipped: "이미 처리된 리소스팩을 건너뛰는 중",
    activityCheckpointLoaded: "저장된 체크포인트 진행 상황을 불러오는 중",
    activityFileError: "일부 파일 오류를 기록하고 작업을 계속 진행 중",
    activityFileWriteRetry: "파일 안전 저장을 재시도하는 중",
    activityCancelRequested: "작업 중지 요청을 처리하는 중",
    activityCancelled: "작업을 안전하게 중지하고 체크포인트를 저장했습니다",
    activityDone: "전체 번역 작업을 완료했습니다",
    activityFailed: "작업 진행이 중단되었습니다",
    summaryIdle: "아직 실행된 작업이 없습니다. 스캔 또는 실제 번역을 시작하면 여기에 실시간 상태가 표시됩니다.",
    summaryQueued: "작업이 대기열에 등록되었습니다. 사전 준비가 완료되면 바로 실행됩니다.",
    summaryRunning: "현재 파일과 번역 배치를 처리하며 진행 상태를 갱신하고 있습니다.",
    summaryCancelled: "작업이 사용자에 의해 중지되었습니다. 체크포인트가 보존되어 있어 언제든 재개할 수 있습니다.",
    summaryCompleted: "총 {changed}개 파일이 수정되었으며, 번역된 텍스트 후보는 {candidates}개입니다.",
    summaryFailed: "작업이 중단되었습니다. 월드 경로, 제공사 설정, 모델 및 API 키를 다시 확인해 주세요.",
    runHintIdle: "월드 폴더 경로를 지정한 후 '스캔만 실행'으로 안전하게 시작하는 것을 권장합니다.",
    runHintReady: "새 번역 작업을 시작할 준비가 되었습니다. 체크포인트 저장이 켜져 있으면 언제든 이어서 할 수 있습니다.",
    runHintRunning: "작업이 진행 중입니다. 중지가 필요하면 '현재 작업 중지'를 누르면 안전하게 정리 후 멈춥니다.",
    runHintResume: "이전에 중단된 작업 기록이 있습니다. '이전 진행 재개'를 누르면 저장된 위치부터 이어서 진행합니다.",
    runHintCancelled: "작업이 안전하게 중지되었습니다. 설정을 유지한 채 '이전 진행 재개'를 누르면 작업을 이어갑니다.",
    runHintFailed: "오류로 중단되었으나 체크포인트가 남아 있습니다. 설정을 확인한 후 재개를 시도하세요.",
    estScale: "예상 작업 규모:",
    estTime: "예상 소요 시간:",
    statPhase: "현재 단계",
    statFiles: "파일 진행도",
    statTexts: "번역 배치 텍스트",
    statChanged: "수정된 파일 수",
    statCandidates: "후보 텍스트 수",
    statLastUpdate: "마지막 갱신 시각",
    currentProvider: "선택된 제공사",
    currentModel: "선택된 모델",
    currentActivity: "현재 세부 동작",
    currentFile: "현재 처리 파일",
    logKicker: "Activity Log",
    logTitle: "작업 상세 로그",
    resultKicker: "Report",
    resultTitle: "결과 JSON 리포트",
    supportKicker: "Support & Notice",
    supportTitle: "안내 사항 및 문의",
    supportCopy: `
<ul style="margin:0 0 1rem 1.5rem; padding:0;">
<li style="margin-bottom:0.5rem;"><strong>API 비용 관리:</strong> 과도한 요청은 API 비용을 발생시킬 수 있습니다. 마인크래프트 번역에는 초고스펙 모델이 필수적이지 않으므로, 빠른 속도와 경제적인 사용을 위해 <strong>가벼운 기본 모델 사용을 권장</strong>합니다.</li>
<li style="margin-bottom:0.5rem;"><strong>지원 버전:</strong> 본 도구는 현재 <strong>마인크래프트 Java Edition 월드만 지원</strong>합니다 (Bedrock Edition은 지원하지 않습니다).</li>
<li style="margin-bottom:0.5rem;"><strong>AI 번역 결과 검토:</strong> AI 특성상 문맥에 따른 오역이나 서식 누락이 발생할 수 있으므로, 번역 후 게임 내에서 텍스트를 직접 확인해 보는 것을 권장합니다.</li>
</ul>
<p style="margin:0;">오류 제보나 기능 개선 아이디어 등 피드백이 있으시다면 언제든 저장소 이슈 또는 문의 메일로 보내주시기 바랍니다.</p>`,
    supportLicense: "MIT License",
    emptyResult: "생성된 결과 리포트가 없습니다.",
    emptyTimeline: "기록된 로그가 없습니다.",
    themeLight: "다크 모드로 전환",
    themeDark: "라이트 모드로 전환",
    exportFilename: "translator-config.json",
    localLoadError: "메타데이터를 불러오지 못해 기본 내장값으로 시작했습니다.",
    geminiWarning: "무료 티어 Gemini API는 분당 요청 제한(15 RPM)이 있습니다. 안정적인 처리를 위해 RPM 제한을 15, TPM 제한을 100만 이하로 설정하는 것을 권장합니다.",
    fieldRpmLimit: "RPM 제한",
    helpRpmLimit: "분당 최대 요청 수 제한 (비워두면 무제한)",
    fieldTpmLimit: "TPM 제한",
    helpTpmLimit: "분당 최대 처리 토큰 수 제한 (비워두면 무제한)",
    localScanStarted: "스캔 작업을 요청했습니다.",
    localTranslateStarted: "실제 번역 작업을 요청했습니다.",
    localResumeStarted: "체크포인트 재개 작업을 요청했습니다.",
    localCancelRequested: "작업 중지 요청을 전송했습니다.",
    localCancelError: "중지 요청 처리 실패: {message}",
    localExported: "현재 설정값을 JSON 파일로 내보냈습니다.",
    localReset: "설정 폼을 기본값으로 복원했습니다.",
    localSubmitError: "작업 생성 실패: {message}",
    eventJobStarted: "번역 작업을 시작했습니다.",
    eventResourcePackStart: "리소스팩 번역을 시작했습니다.",
    eventResourcePackDone: "리소스팩 처리를 완료했습니다. 처리 결과: {count}건",
    eventScanStart: "월드 파일 스캔 시작 · 대상 파일: {total}개",
    eventFileStart: "[{index}/{total}] {file} 처리 시작",
    eventFileDone: "[{index}/{total}] {file} 완료 · 수정 청크: {changed} · 후보 텍스트: {candidates}",
    eventBatchStart: "배치 번역 요청 시작 · 묶음 크기: {count}",
    eventBatchDone: "배치 번역 완료 · 묶음 크기: {count}",
    eventBatchError: "배치 번역 오류 · {message}",
    eventResourcePackSkipped: "이미 처리된 리소스팩 건너뜀 · {file}",
    eventCheckpointLoaded: "체크포인트를 불러왔습니다 · 완료 파일: {files} · 리소스팩: {packs}",
    eventFileError: "파일 처리 오류 기록 · {message}",
    eventWriteRetry: "파일 저장 재시도 · {message}",
    eventCancelRequested: "작업 중지 요청을 전송했습니다.",
    eventCancelled: "작업이 안전하게 중지되었으며 체크포인트를 저장했습니다.",
    eventFatalError: "치명적인 오류 발생 · {message}",
    eventDone: "전체 작업 완료 · 수정 파일: {changed}개 · 후보 텍스트: {candidates}개",
    eventCheckpointIgnored: "설정 또는 대상 월드가 달라 이전 체크포인트를 건너뛰었습니다.",
    localJobRecovered: "새로고침 전 실행 중이던 작업에 다시 연결했습니다.",
    estimateScale: "약 {tokens} 토큰 · 텍스트 {texts}개",
    estimateTimeLimited: "약 {minutes}분 소요 예상",
    estimateTimeUnlimited: "속도 제한 없음",
    confirmKicker: "Final Confirmation",
    confirmTitle: "원본 월드에 번역을 적용할까요?",
    confirmCopy: "실제 번역을 실행하면 월드 파일과 리소스팩 zip이 직접 수정됩니다. 지정된 경로와 백업 옵션을 다시 확인해 주세요.",
    confirmWorldLabel: "대상 월드",
    confirmBackupLabel: "백업 여부",
    confirmBackupEnabled: "켜짐 · 원본 자동 백업 보존",
    confirmBackupDisabled: "꺼짐 · 원본 파일이 직접 수정됩니다",
    confirmCancel: "취소",
    confirmContinue: "백업 확인 후 번역 시작",
    eventCompleted: "결과 리포트를 저장했습니다.",
    eventFailed: "작업 실패: {message}",
    eventUnknown: "알 수 없는 이벤트: {event}",
    relativeNow: "방금 전",
    relativeSeconds: "{count}초 전",
    relativeMinutes: "{count}분 전",
  },
  en: {
    skipToContent: "Skip to main content",
    brandKicker: "World Translator for Minecraft",
    brandTitle: "PomiTranslate",
    brandCopy:
      "Manage AI providers, models, prompts, translation scopes, resource packs, and live progress in one screen. Scan safely first, then proceed to translation once verified.",
    heroKicker: "Minecraft Localization",
    heroTitle: "Flawlessly localize your Minecraft worlds and modpacks",
    heroText:
      "Go beyond simple text translation. Safely process commands, NBT data, and resource packs while retaining their format. Use diverse AI models to preserve proper nouns and tone, creating immersive localized gameplay.",
    providerCustom: "Other / Custom",
    fieldCustomFormat: "API Wire Format",
    optCustomOpenAI: "OpenAI Compatible",
    optCustomAnthropic: "Anthropic Compatible",
    helpCustomFormat: "Select the API specification used by your provider.",
    heroPanelOneTitle: "Select Provider",
    heroPanelOneBody: "Switch seamlessly between OpenAI, Gemini, Anthropic, OpenRouter, and custom endpoints without extra configuration.",
    heroPanelTwoTitle: "Refine Style",
    heroPanelTwoBody: "Expand brief style notes into rich, game-tailored translation instructions using connected AI models.",
    heroPanelThreeTitle: "Real-Time Monitoring",
    heroPanelThreeBody: "Track processed files, text batches, active operations, and timestamps in real time with complete clarity.",
    connectionKicker: "Step 1",
    connectionTitle: "Connection & Model Settings",
    connectionCopy: "Configure your AI provider, model, and world paths. Load available models directly from the provider catalog.",
    connectionTag: "Required Settings",
    fieldWorldDir: "World Folder Path",
    helpWorldDir: "Select the Minecraft world folder containing region, entities, and optional resources.zip.",
    fieldReportPath: "Report Output Path",
    helpReportPath: "Leave blank to save as `translation_report.json` inside the world folder.",
    fieldTranslatePy: "translate.py Path",
    helpTranslatePy: "Legacy script path used to inherit API keys, base URL, model, and prompt defaults.",
    fieldInheritTranslatePy: "Inherit Settings from translate.py",
    helpInheritTranslatePy: "Automatically populate empty API fields using values from translate.py.",
    fieldApiKey: "API Key",
    helpApiKey: "Held exclusively in session memory; never saved to browser storage or plain text files.",
    fieldBaseUrl: "API Base URL",
    fieldModel: "Model Name / ID",
    helpModel: "Enter a model ID manually or select one from the catalog below.",
    fieldTimeout: "Request Timeout (seconds)",
    helpTimeout: "Increase this if your chosen provider or model responds slowly (e.g. 120s or higher).",
    baseUrlHelp: "Default URL: {url} · Environment variable: {env}",
    actionLoadModels: "Fetch Available Models",
    modelCatalogIdle: "Model catalog has not been loaded yet.",
    modelCatalogLoading: "Fetching model catalog from provider…",
    modelCatalogLoaded: "Loaded {count} models. Click any entry to populate the model field.",
    modelCatalogError: "Failed to load model catalog: {message}",
    promptKicker: "Step 2",
    promptTitle: "Target Language & Tone",
    promptCopy: "Choose your target language and tone preset. Use prompt elaboration to turn brief notes into comprehensive instructions.",
    fieldTargetLanguage: "Target Language",
    helpTargetLanguage: "Quickly select Korean, English, or Japanese, or enter a custom language.",
    fieldCustomLanguage: "Custom Language Name",
    helpCustomLanguage: "Examples: 繁體中文, Deutsch, Français, Brazilian Portuguese",
    fieldStylePreset: "Tone & Style Preset",
    fieldStyleBrief: "Additional Style Notes",
    helpStyleBrief: "Examples: medieval fantasy tone, keep proper nouns original, informal speech",
    assistTitle: "AI Prompt Booster",
    assistBody: "Expand brief notes into actionable in-game translation instructions.",
    actionImproveStyle: "Elaborate Instructions",
    assistLoading: "Polishing style instructions…",
    assistDone: "Expanded style instructions applied successfully.",
    assistError: "Failed to refine instructions: {message}",
    fieldStylePrompt: "Expanded Style Instructions",
    helpStylePrompt: "Appended to the base preset. Specify world atmosphere, proper noun handling, and pacing.",
    customPromptToggle: "Expand to enter a full custom system prompt",
    fieldCustomPrompt: "Full Custom System Prompt",
    helpCustomPrompt: "When provided, this replaces both the preset and additional style instructions entirely.",
    targetPreset_ko: "Korean",
    targetPreset_en: "English",
    targetPreset_ja: "Japanese",
    targetPreset_custom: "Custom",
    stylePreset_neutral: "Standard / Natural",
    stylePreset_casual: "Casual / Conversational",
    stylePreset_formal: "Formal / Clear",
    stylePreset_polite: "Polite / Courteous",
    stylePreset_story: "Narrative / Storybook",
    stylePreset_custom: "User-Defined",
    stylePresetDesc_neutral: "Standard, natural phrasing. Safest choice for books, puzzles, and general gameplay.",
    stylePresetDesc_casual: "Friendly conversational tone. Ideal for light dialogue and character interactions.",
    stylePresetDesc_formal: "Dignified, structured tone. Great for historical records, journals, and lore tablets.",
    stylePresetDesc_polite: "Courteous and respectful tone that gently guides the player.",
    stylePresetDesc_story: "Expressive and evocative prose tailored for adventure and fantasy worlds.",
    stylePresetDesc_custom: "Translates strictly according to the custom instructions provided below.",
    scopeKicker: "Step 3",
    scopeTitle: "Translation Scope",
    scopeCopy: "Select which game components to translate. Use presets to quickly configure recommended options.",
    scopePresetRecommended: "Recommended",
    scopePresetStory: "Story-Focused",
    scopePresetAll: "Include Everything",
    scopeGroupCore: "Core Progression Text",
    scopeGroupItems: "Items & Entities",
    scopeGroupScripted: "Commands & Staging",
    scopeBooks: "Book Pages",
    scopeSigns: "Signs",
    scopeTitles: "Title Commands",
    scopeFilteredTitles: "Filtered Title Commands",
    scopeCustomNames: "Custom Names",
    scopeItemNames: "Item Names",
    scopeLore: "Item Lore",
    scopeCommandOutput: "tellraw / title Output",
    scopeSkipCommands: "Skip Raw Command Syntax",
    resourceKicker: "Step 4",
    resourceTitle: "Resource Pack Languages",
    resourceCopy: "Enable only if translating language files within the world's embedded resources.zip. When disabled, resource packs are untouched.",
    fieldResourceEnabled: "Translate Resource Pack Languages",
    fieldZipPaths: "Resource Pack Zip Paths",
    helpZipPaths: "One path per line. Relative paths resolve from the world directory.",
    fieldSourceLangFiles: "Source Language Files",
    helpSourceLangFiles: "Examples: en_us.json, zh_cn.json",
    fieldTargetLangFile: "Target Language File",
    helpTargetLangFile: "Examples: ko_kr.json, ja_jp.json, en_us.json",
    fieldSkipExistingLang: "Skip if target language file already exists",
    advancedKicker: "Optional",
    advancedTitle: "Advanced Settings",
    fieldBatchSize: "Batch Size",
    helpBatchSize: "Number of strings sent per API request. Lower this if you encounter rate limits or timeouts.",
    fieldTemperature: "Sampling Temperature",
    helpTemperature: "Lower values produce more consistent and deterministic translations. 0.1 to 0.4 is recommended.",
    fieldBackupSuffix: "Backup Suffix",
    helpBackupSuffix: "File extension suffix appended to backup copies before writing.",
    fieldBackup: "Automated Safety Backup",
    helpBackup: "Automatically create backups of original files before writing changes.",
    fieldDryRun: "Default to Scan Mode",
    helpDryRun: "Sets the form default to scan mode to prevent accidental writes on submission.",
    fieldCheckpointEnabled: "Save Progress Checkpoints",
    helpCheckpointEnabled: "Enables resuming incomplete jobs after cancellation or unexpected errors.",
    fieldContinueOnError: "Continue on File Error",
    helpContinueOnError: "Skip problematic files and continue processing remaining valid files.",
    fieldCheckpointPath: "Checkpoint File Path",
    helpCheckpointPath: "Leave blank to use `.translation_checkpoint.json` inside the world folder.",
    fieldBatchRetries: "Batch Retry Limit",
    helpBatchRetries: "Number of retries on transient API failure before splitting batches.",
    fieldWriteRetries: "File Write Retry Limit",
    helpWriteRetries: "Number of retries using atomic writes if a file save operation fails.",
    advGroupPerf: "Performance & Rate Limits",
    advGroupRecover: "Backups & Recovery",
    advGroupDebug: "Testing & Diagnostics",
    advGroupMisc: "Additional Rules",
    fieldSkipPatterns: "Skip File Patterns",
    helpSkipPatterns: "Example: *.bak_translate",
    fieldPrefixes: "Translate Key Prefixes",
    helpPrefixes: "One per line. Used when translate keys should be converted to readable text before translation.",
    fieldOverrides: "Forced Replacement Rules",
    helpOverrides: "One `source=translation` rule per line.",
    runKicker: "Step 5",
    runTitle: "Execution",
    runCopy: "We recommend running 'Scan Only' first to verify discovered candidates before executing a full translation.",
    actionScan: "Run Scan Only (Preview)",
    actionTranslate: "Run Full Translation",
    actionResume: "Resume Previous Progress",
    actionCancel: "Stop Current Job",
    actionExport: "Export Settings (JSON)",
    actionReset: "Reset Form Defaults",
    liveKicker: "Live Monitor",
    liveTitle: "Execution Status",
    statusIdle: "Idle",
    statusQueued: "Queued",
    statusRunning: "Running",
    statusCompleted: "Completed",
    statusCancelled: "Cancelled",
    statusFailed: "Failed",
    phaseIdle: "Ready",
    phaseQueued: "Queued",
    phasePreparing: "Preparing",
    phaseResourcePack: "Resource Pack",
    phaseScanPending: "Ready to Scan",
    phaseScan: "Scanning World Files",
    phaseTranslate: "Translating Sentences",
    phaseCancelled: "Cancelled",
    phaseDone: "All Completed",
    phaseFailed: "Failed",
    activityPreparing: "Validating configuration and world paths",
    activityResourcePack: "Processing language files in resource pack zip",
    activityScanStart: "Starting world file scan",
    activityFileStart: "Collecting translation candidates from current file",
    activityFileDone: "Completed current file inspection",
    activityBatchStart: "Dispatching AI translation batch request",
    activityBatchDone: "Applying translated batch to memory",
    activityBatchError: "Batch request failed; retrying with smaller chunks",
    activityResourcePackSkipped: "Skipping already processed resource pack",
    activityCheckpointLoaded: "Loaded progress from checkpoint file",
    activityFileError: "Logged file error and continuing operation",
    activityFileWriteRetry: "Retrying atomic file write",
    activityCancelRequested: "Processing cancellation request",
    activityCancelled: "Job stopped safely; checkpoint saved",
    activityDone: "Full translation job completed successfully",
    activityFailed: "Job execution stopped prematurely",
    summaryIdle: "No job is currently running. Run a scan or translation to view live updates here.",
    summaryQueued: "Job is queued and will commence as soon as initialization finishes.",
    summaryRunning: "Status is updating live based on active file inspection and translation batches.",
    summaryCancelled: "Job was stopped by user. A checkpoint is saved, so you can continue anytime using 'Resume Previous Progress'.",
    summaryCompleted: "Successfully modified {changed} files with {candidates} translated candidates.",
    summaryFailed: "Job stopped prematurely. Please verify paths, provider settings, model ID, and API credentials.",
    runHintIdle: "Select a world folder and start with 'Run Scan Only' for a safe preview.",
    runHintReady: "Ready to start a new job. With checkpoints enabled, you can safely pause and resume anytime.",
    runHintRunning: "A job is active. Click 'Stop Current Job' to safely halt progress and save a checkpoint.",
    runHintResume: "Previous progress was detected. Click 'Resume Previous Progress' to continue from the saved checkpoint.",
    runHintCancelled: "Job is currently paused. Keep your settings and click 'Resume Previous Progress' to continue.",
    runHintFailed: "Stopped due to an error, but a checkpoint is preserved. Verify settings and click resume.",
    estScale: "Estimated Scale:",
    estTime: "Estimated Duration:",
    statPhase: "Current Phase",
    statFiles: "File Progress",
    statTexts: "Batch Texts",
    statChanged: "Modified Files",
    statCandidates: "Candidate Texts",
    statLastUpdate: "Last Updated",
    currentProvider: "Active Provider",
    currentModel: "Active Model",
    currentActivity: "Active Operation",
    currentFile: "Active File",
    logKicker: "Activity Log",
    logTitle: "Operation Details",
    resultKicker: "Report",
    resultTitle: "JSON Report Output",
    supportKicker: "Support & Guidance",
    supportTitle: "Information & Error Reports",
    supportCopy: `
<ul style="margin:0 0 1rem 1.5rem; padding:0;">
<li style="margin-bottom:0.5rem;"><strong>Cost Awareness:</strong> High-volume API calls incur fees. Heavy models are unnecessary for in-game text translation; we recommend <strong>efficient, lightweight base models</strong> for optimal speed and cost.</li>
<li style="margin-bottom:0.5rem;"><strong>Supported Edition:</strong> PomiTranslate currently supports <strong>Minecraft Java Edition worlds only</strong> (Bedrock Edition is not supported).</li>
<li style="margin-bottom:0.5rem;"><strong>Reviewing Translations:</strong> AI translation output may occasionally misinterpret context or omit formatting codes. We encourage verifying translated text in-game.</li>
</ul>
<p style="margin:0;">For bug reports, feature suggestions, or feedback, please open an issue on the repository or contact via email.</p>`,
    supportLicense: "MIT License",
    emptyResult: "No results generated yet.",
    emptyTimeline: "No activity logged yet.",
    themeLight: "Switch to Dark Theme",
    themeDark: "Switch to Light Theme",
    exportFilename: "translator-config.json",
    localLoadError: "Failed to load metadata; initialized with built-in defaults.",
    geminiWarning: "The Gemini API Free Tier is limited to 15 RPM. To avoid errors, we recommend setting RPM limit to 15 and TPM limit under 1,000,000.",
    fieldRpmLimit: "RPM Limit",
    helpRpmLimit: "Maximum requests per minute (leave empty for unlimited)",
    fieldTpmLimit: "TPM Limit",
    helpTpmLimit: "Maximum processed tokens per minute (leave empty for unlimited)",
    localScanStarted: "Submitted scan job to server.",
    localTranslateStarted: "Submitted translation job to server.",
    localResumeStarted: "Submitted checkpoint resume request to server.",
    localCancelRequested: "Sent stop request to active job.",
    localCancelError: "Failed to request cancellation: {message}",
    localExported: "Exported current configuration as JSON.",
    localReset: "Restored form settings to default values.",
    localSubmitError: "Failed to create job: {message}",
    eventJobStarted: "Job initiated.",
    eventResourcePackStart: "Starting resource pack translation.",
    eventResourcePackDone: "Completed resource pack processing. Processed items: {count}",
    eventScanStart: "World scan initiated · Target files: {total}",
    eventFileStart: "[{index}/{total}] Starting {file}",
    eventFileDone: "[{index}/{total}] Completed {file} · Modified chunks: {changed} · Candidates: {candidates}",
    eventBatchStart: "Translation batch dispatched · Batch size: {count}",
    eventBatchDone: "Translation batch completed · Batch size: {count}",
    eventBatchError: "Batch translation error · {message}",
    eventResourcePackSkipped: "Skipping already processed resource pack · {file}",
    eventCheckpointLoaded: "Loaded checkpoint data · Completed files: {files} · Resource packs: {packs}",
    eventFileError: "Logged file error · {message}",
    eventWriteRetry: "Retrying atomic file write · {message}",
    eventCancelRequested: "Cancellation requested.",
    eventCancelled: "Job stopped safely; progress checkpoint saved.",
    eventFatalError: "Fatal error encountered · {message}",
    eventDone: "Job completed · Modified files: {changed} · Translated candidates: {candidates}",
    eventCheckpointIgnored: "Ignored previous checkpoint due to mismatched world or settings.",
    localJobRecovered: "Reconnected to the running job that was active before page reload.",
    estimateScale: "~{tokens} tokens · {texts} texts",
    estimateTimeLimited: "Estimated ~{minutes} min",
    estimateTimeUnlimited: "No rate limit active",
    confirmKicker: "Final Confirmation",
    confirmTitle: "Apply translations to original world?",
    confirmCopy: "Executing translation will directly update world files and embedded resource packs. Please verify the world path and backup settings before continuing.",
    confirmWorldLabel: "Target World",
    confirmBackupLabel: "Backup Status",
    confirmBackupEnabled: "Enabled · Originals preserved in backup",
    confirmBackupDisabled: "Disabled · Originals will be directly overwritten",
    confirmCancel: "Cancel",
    confirmContinue: "Confirm Backup & Translate",
    eventCompleted: "Saved translation report.",
    eventFailed: "Job failed: {message}",
    eventUnknown: "Unknown event: {event}",
    relativeNow: "just now",
    relativeSeconds: "{count}s ago",
    relativeMinutes: "{count}m ago",
  },
  ja: {
    skipToContent: "メインコンテンツへスキップ",
    brandKicker: "World Translator for Minecraft",
    brandTitle: "PomiTranslate",
    brandCopy:
      "AIプロバイダー、モデル、プロンプト、翻訳範囲、リソースパック設定、進行状況をひとつの画面で管理します。まずは安全にスキャンを行い、確認後に本翻訳へ進んでください。",
    heroKicker: "Minecraft Localization",
    heroTitle: "マインクラフトのワールドとモッドパックを\nお好みの言語へ完璧に翻訳します",
    heroText:
      "単なるテキスト翻訳を超えて、コマンドやNBTデータ、リソースパックまで形式を保ったまま安全に処理します。多様なAIを活用して固有名詞や口調を維持し、没入感のあるゲーム環境を構築しましょう。",
    providerCustom: "その他 / Custom",
    fieldCustomFormat: "API通信規格形式",
    optCustomOpenAI: "OpenAI 互換",
    optCustomAnthropic: "Anthropic 互換",
    helpCustomFormat: "プロバイダーが準拠するAPI規格を選択してください。",
    heroPanelOneTitle: "プロバイダー選択",
    heroPanelOneBody: "OpenAI、Gemini、Anthropic、OpenRouter、Customなど多様なAIを柔軟に切り替えて利用できます。",
    heroPanelTwoTitle: "文体の調整",
    heroPanelTwoBody: "簡単なメモを入力するだけで、ゲームに最適化された具体的な翻訳指示文へAIが補強します。",
    heroPanelThreeTitle: "リアルタイム監視",
    heroPanelThreeBody: "処理ファイル数、翻訳バッチ、処理中ファイル、最終更新時刻をリアルタイムで明確に把握できます。",
    connectionKicker: "Step 1",
    connectionTitle: "接続とモデル設定",
    connectionCopy: "使用するAIプロバイダー、モデル、ワールドフォルダーを指定します。モデル一覧取得から簡単に選択可能です。",
    connectionTag: "必須設定",
    fieldWorldDir: "ワールドフォルダーのパス",
    helpWorldDir: "region、entities、resources.zip を含むマインクラフトのワールドフォルダーを指定します。",
    fieldReportPath: "レポート出力先パス",
    helpReportPath: "空欄の場合はワールド内の `translation_report.json` に保存されます。",
    fieldTranslatePy: "translate.py のパス",
    helpTranslatePy: "APIキー、Base URL、モデル、プロンプト設定を継承する既存スクリプトのパスです。",
    fieldInheritTranslatePy: "translate.py から設定を継承",
    helpInheritTranslatePy: "空欄のAPI設定項目を translate.py の値で自動補完します。",
    fieldApiKey: "APIキー",
    helpApiKey: "現在のセッションメモリでのみ保持され、ブラウザストレージやファイルには保存されません。",
    fieldBaseUrl: "API Base URL",
    fieldModel: "モデル名 (ID)",
    helpModel: "モデルIDを直接入力するか、下の一覧からクリックして入力してください。",
    fieldTimeout: "リクエスト制限時間 (秒)",
    helpTimeout: "応答に時間がかかるモデルを使用する場合は長め（例: 120秒以上）に設定してください。",
    baseUrlHelp: "既定URL: {url} · 環境変数: {env}",
    actionLoadModels: "利用可能なモデル一覧を取得",
    modelCatalogIdle: "まだモデル一覧を取得していません。",
    modelCatalogLoading: "プロバイダーからモデル一覧を取得中…",
    modelCatalogLoaded: "{count}件のモデルを取得しました。クリックすると入力欄に反映されます。",
    modelCatalogError: "モデル一覧の取得に失敗しました: {message}",
    promptKicker: "Step 2",
    promptTitle: "翻訳先言語と文体",
    promptCopy: "翻訳先の言語と文体プリセットを指定します。指示の具体化機能を使えば、短いメモから高品質な翻訳指示を生成できます。",
    fieldTargetLanguage: "翻訳先言語",
    helpTargetLanguage: "日本語、韓国語、英語はボタンで素早く選択できます。直接入力も可能です。",
    fieldCustomLanguage: "直接入力の言語名",
    helpCustomLanguage: "例: 繁體中文, Deutsch, Français, Brazilian Portuguese",
    fieldStylePreset: "基本文体プリセット",
    fieldStyleBrief: "追加スタイルメモ (文体、固有名詞など)",
    helpStyleBrief: "例: 中世ファンタジー風、固有名詞は原文維持、親しみやすい口調",
    assistTitle: "AI指示の具体化",
    assistBody: "入力したメモをマインクラフト翻訳に最適化された詳細なシステム指示文へ拡張します。",
    actionImproveStyle: "指示文を具体化",
    assistLoading: "スタイル指示を調整中…",
    assistDone: "スタイル指示の補強が完了しました。",
    assistError: "スタイル補強に失敗しました: {message}",
    fieldStylePrompt: "補強された追加スタイル指示",
    helpStylePrompt: "基本プリセットの後ろに追加される詳細指示です。世界観、固有名詞の扱いなどを指定します。",
    customPromptToggle: "システムプロンプト全文を直接入力する場合は開く",
    fieldCustomPrompt: "システムプロンプト全文",
    helpCustomPrompt: "ここに入力がある場合、プリセットや追加指示の代わりにこの内容が全面的に使用されます。",
    targetPreset_ko: "韓国語",
    targetPreset_en: "英語",
    targetPreset_ja: "日本語",
    targetPreset_custom: "直接入力",
    stylePreset_neutral: "標準・自然",
    stylePreset_casual: "カジュアル・会話調",
    stylePreset_formal: "フォーマル・明瞭",
    stylePreset_polite: "丁寧な敬語",
    stylePreset_story: "小説・ファンタジー風",
    stylePreset_custom: "ユーザー独自指定",
    stylePresetDesc_neutral: "標準的で自然な文体です。本、看板、システム案内など全般に最適です。",
    stylePresetDesc_casual: "親しみやすい会話調です。NPCのセリフや軽快なマップに適しています。",
    stylePresetDesc_formal: "格式高く整った文体です。日誌、歴史書、荘厳な世界観に適しています。",
    stylePresetDesc_polite: "プレイヤーへ向けて丁寧かつ親切に案内する敬語表現です。",
    stylePresetDesc_story: "ファンタジーや冒険小説にふさわしい、情緒豊かで没入感のある文体です。",
    stylePresetDesc_custom: "固定の文体を使わず、下の追加指示欄に記述された内容のみで翻訳を制御します。",
    scopeKicker: "Step 3",
    scopeTitle: "翻訳対象範囲",
    scopeCopy: "ワールド内で翻訳する要素を選択します。プリセットを使用して推奨構成を簡単に適用できます。",
    scopePresetRecommended: "推奨構成",
    scopePresetStory: "ストーリー重視",
    scopePresetAll: "すべて対象",
    scopeGroupCore: "重要テキスト",
    scopeGroupItems: "アイテム・エンティティ",
    scopeGroupScripted: "コマンド・演出",
    scopeBooks: "本のページ",
    scopeSigns: "看板",
    scopeTitles: "title コマンド",
    scopeFilteredTitles: "filtered_title コマンド",
    scopeCustomNames: "カスタム名",
    scopeItemNames: "アイテム名",
    scopeLore: "アイテム説明 (Lore)",
    scopeCommandOutput: "tellraw / title 出力テキスト",
    scopeSkipCommands: "コマンド構文そのものは翻訳除外",
    resourceKicker: "Step 4",
    resourceTitle: "リソースパック言語ファイル",
    resourceCopy: "ワールド内蔵リソースパック(resources.zip)の翻訳が必要な場合のみ有効にしてください。無効時は変更されません。",
    fieldResourceEnabled: "リソースパック言語ファイルの翻訳を有効化",
    fieldZipPaths: "リソースパック zip パス一覧",
    helpZipPaths: "1行に1つ入力します。相対パスはワールドフォルダー基準で計算されます。",
    fieldSourceLangFiles: "元の lang ファイル名",
    helpSourceLangFiles: "例: en_us.json, zh_cn.json",
    fieldTargetLangFile: "出力先 lang ファイル名",
    helpTargetLangFile: "例: ja_jp.json, ko_kr.json, en_us.json",
    fieldSkipExistingLang: "出力先言語ファイルが既に存在する場合はスキップ",
    advancedKicker: "Optional",
    advancedTitle: "詳細設定",
    fieldBatchSize: "バッチサイズ (Batch Size)",
    helpBatchSize: "1回のAPIリクエストに含める文字列数です。エラーが頻発する場合は数値を下げてください。",
    fieldTemperature: "多様性 (Temperature)",
    helpTemperature: "低いほど安定的で一貫した翻訳になります。通常は 0.1 ～ 0.4 が推奨されます。",
    fieldBackupSuffix: "バックアップ接尾辞 (Suffix)",
    helpBackupSuffix: "元ファイルバックアップ時に付与される拡張子接尾辞です。",
    fieldBackup: "元ファイルの安全バックアップ",
    helpBackup: "ファイル書き込みを行う前に、対象となる元ファイルを自動バックアップします。",
    fieldDryRun: "既定の実行モードをスキャンに設定",
    helpDryRun: "誤って直接書き込みを行わないよう、初期実行モードをスキャンに設定します。",
    fieldCheckpointEnabled: "チェックポイント保存",
    helpCheckpointEnabled: "作業の中断やエラー発生時に続きから再開できるよう、進捗を自動保存します。",
    fieldContinueOnError: "ファイルエラー発生時も処理を継続",
    helpContinueOnError: "破損ファイルがあってもそのファイルをスキップし、残りの正常なファイルの処理を続けます。",
    fieldCheckpointPath: "チェックポイント保存先",
    helpCheckpointPath: "空欄の場合はワールド内の `.translation_checkpoint.json` に保存されます。",
    fieldBatchRetries: "バッチ失敗時の再試行回数",
    helpBatchRetries: "APIの一時的なエラー時に再試行する最大回数です。",
    fieldWriteRetries: "ファイル書き込み再試行回数",
    helpWriteRetries: "書き込み失敗時に原子的（Atomic）保存で再試行する回数です。",
    advGroupPerf: "パフォーマンス・レート制限",
    advGroupRecover: "バックアップ・復元",
    advGroupDebug: "テスト・診断",
    advGroupMisc: "追加ルール",
    fieldSkipPatterns: "スキャン除外ファイルパターン",
    helpSkipPatterns: "例: *.bak_translate",
    fieldPrefixes: "翻訳キー接頭辞 (Translate Key Prefix)",
    helpPrefixes: "1行に1つ入力します。translateキーを可読テキストへ変換してから翻訳する場合に使用します。",
    fieldOverrides: "強制テキスト置換ルール",
    helpOverrides: "1行に `原文=翻訳文` の形式で入力します。",
    runKicker: "Step 5",
    runTitle: "実行",
    runCopy: "まずは「スキャンのみ実行」で候補テキストを確認し、問題がなければ「本翻訳を実行」へ進む手順を強く推奨します。",
    actionScan: "スキャンのみ実行 (プレビュー)",
    actionTranslate: "本翻訳を実行",
    actionResume: "前回の進行を再開",
    actionCancel: "現在の作業を停止",
    actionExport: "設定JSONをエクスポート",
    actionReset: "フォーム既定値を復元",
    liveKicker: "Live Monitor",
    liveTitle: "実行状態モニター",
    statusIdle: "待機中",
    statusQueued: "キュー待ち",
    statusRunning: "実行中",
    statusCompleted: "完了",
    statusCancelled: "停止済み",
    statusFailed: "失敗",
    phaseIdle: "準備待ち",
    phaseQueued: "待機中",
    phasePreparing: "初期準備",
    phaseResourcePack: "リソースパック処理中",
    phaseScanPending: "スキャン準備完了",
    phaseScan: "ワールドファイル走査中",
    phaseTranslate: "文章翻訳進行中",
    phaseCancelled: "停止済み",
    phaseDone: "全工程完了",
    phaseFailed: "処理失敗",
    activityPreparing: "設定とワールドパスを検証中",
    activityResourcePack: "リソースパックzip内の言語ファイルを処理中",
    activityScanStart: "ワールドファイルのスキャンを開始",
    activityFileStart: "ファイルから翻訳対象テキストを収集中",
    activityFileDone: "現在のファイルの検査を完了",
    activityBatchStart: "AI翻訳バッチリクエストを送信中",
    activityBatchDone: "翻訳バッチ結果をデータに反映中",
    activityBatchError: "バッチ失敗のため小分けにして再試行中",
    activityResourcePackSkipped: "処理済みのリソースパックをスキップ中",
    activityCheckpointLoaded: "保存済みチェックポイントを読み込み中",
    activityFileError: "ファイルエラーを記録し処理を継続中",
    activityFileWriteRetry: "ファイルの安全書き込みを再試行中",
    activityCancelRequested: "停止リクエストを処理中",
    activityCancelled: "作業を安全に停止しチェックポイントを保存しました",
    activityDone: "すべての翻訳処理を正常に完了しました",
    activityFailed: "ジョブの実行が中断されました",
    summaryIdle: "実行中のジョブはありません。スキャンまたは本翻訳を開始すると、ここにリアルタイム進捗が表示されます。",
    summaryQueued: "ジョブがキューに入りました。初期化が完了次第、処理を開始します。",
    summaryRunning: "現在のファイル走査と翻訳バッチの進捗状況をリアルタイムで更新しています。",
    summaryCancelled: "ユーザーによって作業が停止されました。チェックポイントが保存されているため、「前回の進行を再開」からいつでも再開できます。",
    summaryCompleted: "合計 {changed} 個のファイルが変更され、翻訳されたテキスト候補は {candidates} 件です。",
    summaryFailed: "作業が中断されました。ワールドパス、プロバイダー設定、モデルID、API認証情報を確認してください。",
    runHintIdle: "ワールドフォルダーを指定し、まずは「スキャンのみ実行」で安全に確認することをお勧めします。",
    runHintReady: "新しいジョブを開始できます。チェックポイント保存が有効な場合、いつでも安全に一時停止と再開が可能です。",
    runHintRunning: "ジョブが実行中です。安全に止めたい場合は「現在の作業を停止」を押すと進捗を保存して停止します。",
    runHintResume: "以前の中断データが検出されました。「前回の進行を再開」を押すと保存された位置から続行します。",
    runHintCancelled: "作業は一時停止中です。設定を維持したまま「前回の進行を再開」を押すと続きから実行します。",
    runHintFailed: "エラーにより停止しましたがチェックポイントが保持されています。設定を確認後に再開してください。",
    estScale: "予想作業規模:",
    estTime: "予想所要時間:",
    statPhase: "現在の段階",
    statFiles: "ファイル進捗",
    statTexts: "バッチ文字列数",
    statChanged: "変更ファイル数",
    statCandidates: "候補テキスト数",
    statLastUpdate: "最終更新時刻",
    currentProvider: "選択中のプロバイダー",
    currentModel: "選択中のモデル",
    currentActivity: "現在の詳細動作",
    currentFile: "処理中のファイル",
    logKicker: "Activity Log",
    logTitle: "作業ログ詳細",
    resultKicker: "Report",
    resultTitle: "結果 JSON レポート",
    supportKicker: "Support & Notice",
    supportTitle: "注意事項とサポート",
    supportCopy: `
<ul style="margin:0 0 1rem 1.5rem; padding:0;">
<li style="margin-bottom:0.5rem;"><strong>API利用料金について:</strong> 過剰なリクエストはAPI料金の発生につながります。ゲーム内テキスト翻訳には超高スペックなモデルは必須ではないため、速度と費用のバランスが良い<strong>軽量ベースモデルの使用を推奨</strong>します。</li>
<li style="margin-bottom:0.5rem;"><strong>対応エディション:</strong> 本ツールは現在 <strong>Minecraft Java Edition ワールド専用</strong>です（Bedrock Editionには対応していません）。</li>
<li style="margin-bottom:0.5rem;"><strong>翻訳結果の確認:</strong> AI翻訳の特性上、文脈による誤訳や書式コードの欠落が生じる場合があります。翻訳後はゲーム内で実際の表示を確認することをお勧めします。</li>
</ul>
<p style="margin:0;">バグ報告や改善提案などのフィードバックがございましたら、リポジトリのIssueまたは記載のメールアドレスまでお気軽にお寄せください。</p>`,
    supportLicense: "MIT License",
    emptyResult: "生成されたレポートはまだありません。",
    emptyTimeline: "ログの記録はまだありません。",
    themeLight: "ダークモードへ切り替え",
    themeDark: "ライトモードへ切り替え",
    exportFilename: "translator-config.json",
    localLoadError: "メタデータを読み込めなかったため、内蔵の既定値で初期化しました。",
    geminiWarning: "無料利用枠のGemini APIには分当たりリクエスト制限(15 RPM)があります。安定処理のため、RPM制限を15、TPM制限を100万以下に設定することを推奨します。",
    fieldRpmLimit: "RPM制限",
    helpRpmLimit: "1分あたりの最大リクエスト数 (空欄で無制限)",
    fieldTpmLimit: "TPM制限",
    helpTpmLimit: "1分あたりの最大処理トークン数 (空欄で無制限)",
    localScanStarted: "スキャンジョブをサーバーへ要求しました。",
    localTranslateStarted: "本翻訳ジョブをサーバーへ要求しました。",
    localResumeStarted: "チェックポイント再開をサーバーへ要求しました。",
    localCancelRequested: "実行中のジョブへ停止要求を送信しました。",
    localCancelError: "停止要求の処理に失敗しました: {message}",
    localExported: "現在の設定内容を JSON ファイルとして保存しました。",
    localReset: "フォーム設定を既定値にリセットしました。",
    localSubmitError: "ジョブの作成に失敗しました: {message}",
    eventJobStarted: "翻訳ジョブを開始しました。",
    eventResourcePackStart: "リソースパックの翻訳を開始しました。",
    eventResourcePackDone: "リソースパックの処理が完了しました。処理件数: {count}件",
    eventScanStart: "ワールドファイル走査開始 · 対象ファイル数: {total}個",
    eventFileStart: "[{index}/{total}] {file} の処理を開始",
    eventFileDone: "[{index}/{total}] {file} 完了 · 変更チャンク: {changed} · 候補テキスト: {candidates}",
    eventBatchStart: "翻訳バッチ要求を送信中 · バッチサイズ: {count}",
    eventBatchDone: "翻訳バッチ処理が完了しました · バッチサイズ: {count}",
    eventBatchError: "バッチ翻訳エラー · {message}",
    eventResourcePackSkipped: "処理済みのリソースパックをスキップ · {file}",
    eventCheckpointLoaded: "チェックポイントを読み込みました · 完了ファイル: {files} · リソースパック: {packs}",
    eventFileError: "ファイル処理エラーを記録 · {message}",
    eventWriteRetry: "ファイルの安全保存を再試行 · {message}",
    eventCancelRequested: "停止要求を送信しました。",
    eventCancelled: "作業が安全に停止され、チェックポイントが保存されました。",
    eventFatalError: "致命的なエラーが発生しました · {message}",
    eventDone: "全行程が完了しました · 変更ファイル: {changed}個 · 候補テキスト: {candidates}個",
    eventCheckpointIgnored: "ワールドまたは設定が異なるため、前回のチェックポイントをスキップしました。",
    localJobRecovered: "ページ再読み込み前に実行中だったジョブに再接続しました。",
    estimateScale: "約 {tokens} トークン · テキスト {texts}件",
    estimateTimeLimited: "所要時間 約 {minutes}分",
    estimateTimeUnlimited: "速度制限なし",
    confirmKicker: "Final Confirmation",
    confirmTitle: "元のワールドへ翻訳を適用しますか？",
    confirmCopy: "本翻訳を実行すると、ワールドファイルとリソースパック zip が直接変更されます。指定されたパスとバックアップ設定を再度ご確認ください。",
    confirmWorldLabel: "対象ワールド",
    confirmBackupLabel: "バックアップ",
    confirmBackupEnabled: "有効 · 元ファイルを安全に自動バックアップ",
    confirmBackupDisabled: "無効 · 元ファイルが直接上書きされます",
    confirmCancel: "キャンセル",
    confirmContinue: "バックアップを確認して翻訳開始",
    eventCompleted: "結果レポートを保存しました。",
    eventFailed: "ジョブ失敗: {message}",
    eventUnknown: "不明なイベント: {event}",
    relativeNow: "たった今",
    relativeSeconds: "{count}秒前",
    relativeMinutes: "{count}分前",
  },
};

const state = {
  lang: localStorage.getItem("mc-world-ui-lang") || "ko",
  theme: localStorage.getItem("mc-world-ui-theme") || "light",
  meta: FALLBACK_META,
  draft: null,
  modelCatalog: [],
  activeJobId: null,
  job: null,
  localEvents: [],
  pollTimer: null,
  pollInFlight: false,
  renderTimer: null,
};

const dom = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindDom();
  bindEvents();
  applyLanguage();
  applyTheme();

  try {
    const response = await apiFetch("/api/meta");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    state.meta = await response.json();
  } catch {
    state.meta = FALLBACK_META;
    pushLocalEvent("localLoadError", {}, true);
  }

  const draft = loadDraft() || buildDefaultDraft();
  state.draft = draft;
  renderStaticUi();
  populateForm(draft);
  renderMonitor();
  await recoverActiveJob();
  state.renderTimer = window.setInterval(refreshRelativeTime, 1000);
}

function bindDom() {
  Object.assign(dom, {
    themeToggle: document.getElementById("themeToggle"),
    providerPicker: document.getElementById("providerPicker"),
    geminiWarning: document.getElementById("geminiWarning"),
    customProviderSettings: document.getElementById("customProviderSettings"),
    customProviderFormat: document.getElementById("customProviderFormat"),
    worldDir: document.getElementById("worldDir"),
    reportPath: document.getElementById("reportPath"),
    translatePyPath: document.getElementById("translatePyPath"),
    inheritTranslatePy: document.getElementById("inheritTranslatePy"),
    apiKey: document.getElementById("apiKey"),
    baseUrl: document.getElementById("baseUrl"),
    baseUrlHelp: document.getElementById("baseUrlHelp"),
    model: document.getElementById("model"),
    requestTimeout: document.getElementById("requestTimeout"),
    loadModelsButton: document.getElementById("loadModelsButton"),
    modelCatalogStatus: document.getElementById("modelCatalogStatus"),
    modelCatalog: document.getElementById("modelCatalog"),
    targetLanguagePreset: document.getElementById("targetLanguagePreset"),
    customLanguageField: document.getElementById("customLanguageField"),
    customLanguage: document.getElementById("customLanguage"),
    stylePreset: document.getElementById("stylePreset"),
    stylePresetHelp: document.getElementById("stylePresetHelp"),
    styleBrief: document.getElementById("styleBrief"),
    improveStyleButton: document.getElementById("improveStyleButton"),
    styleAssistStatus: document.getElementById("styleAssistStatus"),
    stylePrompt: document.getElementById("stylePrompt"),
    customSystemPrompt: document.getElementById("customSystemPrompt"),
    translateBooks: document.getElementById("translateBooks"),
    translateSigns: document.getElementById("translateSigns"),
    translateTitles: document.getElementById("translateTitles"),
    translateFilteredTitles: document.getElementById("translateFilteredTitles"),
    translateCustomNames: document.getElementById("translateCustomNames"),
    translateItemNames: document.getElementById("translateItemNames"),
    translateLore: document.getElementById("translateLore"),
    translateCommandOutput: document.getElementById("translateCommandOutput"),
    skipCommandLikeText: document.getElementById("skipCommandLikeText"),
    resourceEnabled: document.getElementById("resourceEnabled"),
    resourcePanel: document.getElementById("resourcePanel"),
    zipPaths: document.getElementById("zipPaths"),
    sourceLangFiles: document.getElementById("sourceLangFiles"),
    targetLangFile: document.getElementById("targetLangFile"),
    skipIfTargetExists: document.getElementById("skipIfTargetExists"),
    batchSize: document.getElementById("batchSize"),
    temperature: document.getElementById("temperature"),
    rpmLimit: document.getElementById("rpmLimit"),
    tpmLimit: document.getElementById("tpmLimit"),
    backupSuffix: document.getElementById("backupSuffix"),
    backup: document.getElementById("backup"),
    checkpointEnabled: document.getElementById("checkpointEnabled"),
    continueOnFileError: document.getElementById("continueOnFileError"),
    checkpointPath: document.getElementById("checkpointPath"),
    maxBatchRetries: document.getElementById("maxBatchRetries"),
    maxFileWriteRetries: document.getElementById("maxFileWriteRetries"),
    skipPatterns: document.getElementById("skipPatterns"),
    componentPrefixes: document.getElementById("componentPrefixes"),
    overrides: document.getElementById("overrides"),
    scanButton: document.getElementById("scanButton"),
    translateButton: document.getElementById("translateButton"),
    resumeButton: document.getElementById("resumeButton"),
    cancelButton: document.getElementById("cancelButton"),
    exportButton: document.getElementById("exportButton"),
    resetButton: document.getElementById("resetButton"),
    runHint: document.getElementById("runHint"),
    estScale: document.getElementById("estScale"),
    estTime: document.getElementById("estTime"),
    statusPill: document.getElementById("statusPill"),
    livePulse: document.getElementById("livePulse"),
    progressNumber: document.getElementById("progressNumber"),
    progressShell: document.getElementById("progressShell"),
    progressBar: document.getElementById("progressBar"),
    monitorSummary: document.getElementById("monitorSummary"),
    statPhase: document.getElementById("statPhase"),
    statFiles: document.getElementById("statFiles"),
    statTexts: document.getElementById("statTexts"),
    statChanged: document.getElementById("statChanged"),
    statCandidates: document.getElementById("statCandidates"),
    statLastUpdate: document.getElementById("statLastUpdate"),
    currentProvider: document.getElementById("currentProvider"),
    currentModel: document.getElementById("currentModel"),
    currentActivity: document.getElementById("currentActivity"),
    currentFile: document.getElementById("currentFile"),
    timeline: document.getElementById("timeline"),
    resultPanel: document.getElementById("resultPanel"),
    translationConfirmDialog: document.getElementById("translationConfirmDialog"),
    confirmWorldPath: document.getElementById("confirmWorldPath"),
    confirmBackupState: document.getElementById("confirmBackupState"),
    confirmCancelButton: document.getElementById("confirmCancelButton"),
    confirmContinueButton: document.getElementById("confirmContinueButton"),
  });
}

function bindEvents() {
  document.querySelectorAll("[data-lang-switch]").forEach((button) => {
    button.addEventListener("click", () => {
      state.lang = button.dataset.langSwitch;
      localStorage.setItem("mc-world-ui-lang", state.lang);
      renderStaticUi();
      renderMonitor();
    });
  });

  dom.themeToggle.addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("mc-world-ui-theme", state.theme);
    applyTheme();
  });

  dom.targetLanguagePreset.addEventListener("change", () => {
    toggleCustomLanguageField();
    persistDraft();
  });

  dom.stylePreset.addEventListener("change", () => {
    updateStylePresetHelp();
    persistDraft();
  });

  dom.resourceEnabled.addEventListener("change", () => {
    toggleResourcePanel();
    persistDraft();
  });

  dom.customProviderFormat.addEventListener("change", (e) => {
    state.draft.provider = e.target.value;
    persistDraft();
    updateBaseUrlHelp();
  });

  dom.loadModelsButton.addEventListener("click", loadModels);
  dom.improveStyleButton.addEventListener("click", improveStylePrompt);

  document.querySelectorAll("[data-scope-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      applyScopePreset(button.dataset.scopePreset);
      persistDraft();
    });
  });

  [
    dom.worldDir,
    dom.reportPath,
    dom.translatePyPath,
    dom.inheritTranslatePy,
    dom.apiKey,
    dom.baseUrl,
    dom.model,
    dom.requestTimeout,
    dom.customLanguage,
    dom.styleBrief,
    dom.stylePrompt,
    dom.customSystemPrompt,
    dom.translateBooks,
    dom.translateSigns,
    dom.translateTitles,
    dom.translateFilteredTitles,
    dom.translateCustomNames,
    dom.translateItemNames,
    dom.translateLore,
    dom.translateCommandOutput,
    dom.skipCommandLikeText,
    dom.zipPaths,
    dom.sourceLangFiles,
    dom.targetLangFile,
    dom.skipIfTargetExists,
    dom.batchSize,
    dom.temperature,
    dom.rpmLimit,
    dom.tpmLimit,
    dom.backupSuffix,
    dom.backup,
    dom.checkpointEnabled,
    dom.continueOnFileError,
    dom.checkpointPath,
    dom.maxBatchRetries,
    dom.maxFileWriteRetries,
    dom.skipPatterns,
    dom.componentPrefixes,
    dom.overrides,
  ].forEach((element) => {
    element.addEventListener("input", persistDraft);
    element.addEventListener("change", persistDraft);
  });

  dom.scanButton.addEventListener("click", () => submitJob(true));
  dom.translateButton.addEventListener("click", () => submitJob(false));
  dom.resumeButton.addEventListener("click", resumeJob);
  dom.cancelButton.addEventListener("click", cancelJob);
  dom.exportButton.addEventListener("click", exportSettings);
  dom.resetButton.addEventListener("click", resetForm);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  dom.themeToggle.textContent = state.theme === "light" ? t("themeLight") : t("themeDark");
}

function applyLanguage() {
  document.documentElement.lang = state.lang;
  document.querySelectorAll("[data-lang-switch]").forEach((button) => {
    button.classList.toggle("active", button.dataset.langSwitch === state.lang);
  });
}

function renderStaticUi() {
  applyLanguage();
  applyTheme();
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((node) => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  renderProviderPicker();
  renderTargetLanguageOptions();
  renderStylePresetOptions();
  updateStylePresetHelp();
  updateBaseUrlHelp();
  toggleCustomLanguageField();
  toggleResourcePanel();
  renderModelCatalog();
}

function buildDefaultDraft() {
  const meta = state.meta || FALLBACK_META;
  return {
    provider: meta.defaults.provider || "comet",
    worldDir: meta.example_paths.world_dir || "",
    reportPath: "",
    translatePyPath: meta.example_paths.translate_py_path || "",
    inheritTranslatePy: true,
    apiKey: "",
    baseUrl: providerDefaultUrl(meta.defaults.provider || "comet"),
    model: "",
    requestTimeout: meta.defaults.request_timeout || 120,
    targetLanguagePreset: "ko",
    customLanguage: "",
    stylePreset: "neutral",
    styleBrief: "",
    stylePrompt: "",
    customSystemPrompt: "",
    translateBooks: true,
    translateSigns: true,
    translateTitles: true,
    translateFilteredTitles: true,
    translateCustomNames: true,
    translateItemNames: true,
    translateLore: true,
    translateCommandOutput: true,
    skipCommandLikeText: true,
    resourceEnabled: false,
    zipPaths: "",
    sourceLangFiles: (meta.defaults.resource_pack_source_lang_files || ["en_us.json", "zh_cn.json"]).join("\n"),
    targetLangFile: "ko_kr.json",
    skipIfTargetExists: false,
    batchSize: meta.defaults.batch_size || 40,
    temperature: meta.defaults.temperature || 0.3,
    rpmLimit: "",
    tpmLimit: "",
    backupSuffix: meta.defaults.backup_suffix || ".bak_translate",
    backup: true,
    checkpointEnabled: meta.defaults.checkpoint_enabled ?? true,
    continueOnFileError: meta.defaults.continue_on_file_error ?? true,
    checkpointPath: "",
    maxBatchRetries: meta.defaults.max_batch_retries ?? 3,
    maxFileWriteRetries: meta.defaults.max_file_write_retries ?? 2,
    skipPatterns: (meta.defaults.skip_patterns || []).join("\n"),
    componentPrefixes: "",
    overrides: "",
  };
}

function loadDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persistDraft() {
  state.draft = collectDraft();
  const stored = { ...state.draft, apiKey: "" };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function collectDraft() {
  return {
    provider: state.draft?.provider || providerFromPicker(),
    worldDir: dom.worldDir.value,
    reportPath: dom.reportPath.value,
    translatePyPath: dom.translatePyPath.value,
    inheritTranslatePy: dom.inheritTranslatePy.checked,
    apiKey: dom.apiKey.value,
    baseUrl: dom.baseUrl.value,
    model: dom.model.value,
    requestTimeout: dom.requestTimeout.value,
    targetLanguagePreset: dom.targetLanguagePreset.value,
    customLanguage: dom.customLanguage.value,
    stylePreset: dom.stylePreset.value,
    styleBrief: dom.styleBrief.value,
    stylePrompt: dom.stylePrompt.value,
    customSystemPrompt: dom.customSystemPrompt.value,
    translateBooks: dom.translateBooks.checked,
    translateSigns: dom.translateSigns.checked,
    translateTitles: dom.translateTitles.checked,
    translateFilteredTitles: dom.translateFilteredTitles.checked,
    translateCustomNames: dom.translateCustomNames.checked,
    translateItemNames: dom.translateItemNames.checked,
    translateLore: dom.translateLore.checked,
    translateCommandOutput: dom.translateCommandOutput.checked,
    skipCommandLikeText: dom.skipCommandLikeText.checked,
    resourceEnabled: dom.resourceEnabled.checked,
    zipPaths: dom.zipPaths.value,
    sourceLangFiles: dom.sourceLangFiles.value,
    targetLangFile: dom.targetLangFile.value,
    skipIfTargetExists: dom.skipIfTargetExists.checked,
    batchSize: dom.batchSize.value,
    temperature: dom.temperature.value,
    rpmLimit: dom.rpmLimit.value,
    tpmLimit: dom.tpmLimit.value,
    backupSuffix: dom.backupSuffix.value,
    backup: dom.backup.checked,
    checkpointEnabled: dom.checkpointEnabled.checked,
    continueOnFileError: dom.continueOnFileError.checked,
    checkpointPath: dom.checkpointPath.value,
    maxBatchRetries: dom.maxBatchRetries.value,
    maxFileWriteRetries: dom.maxFileWriteRetries.value,
    skipPatterns: dom.skipPatterns.value,
    componentPrefixes: dom.componentPrefixes.value,
    overrides: dom.overrides.value,
  };
}

function populateForm(draft) {
  state.draft = { ...buildDefaultDraft(), ...draft };
  dom.worldDir.value = state.draft.worldDir || "";
  dom.reportPath.value = state.draft.reportPath || "";
  dom.translatePyPath.value = state.draft.translatePyPath || "";
  dom.inheritTranslatePy.checked = !!state.draft.inheritTranslatePy;
  dom.apiKey.value = "";
  dom.baseUrl.value = state.draft.baseUrl || providerDefaultUrl(state.draft.provider);
  dom.model.value = state.draft.model || "";
  dom.requestTimeout.value = state.draft.requestTimeout || 120;
  dom.targetLanguagePreset.value = state.draft.targetLanguagePreset || "ko";
  dom.customLanguage.value = state.draft.customLanguage || "";
  dom.stylePreset.value = state.draft.stylePreset || "neutral";
  dom.styleBrief.value = state.draft.styleBrief || "";
  dom.stylePrompt.value = state.draft.stylePrompt || "";
  dom.customSystemPrompt.value = state.draft.customSystemPrompt || "";
  dom.translateBooks.checked = !!state.draft.translateBooks;
  dom.translateSigns.checked = !!state.draft.translateSigns;
  dom.translateTitles.checked = !!state.draft.translateTitles;
  dom.translateFilteredTitles.checked = !!state.draft.translateFilteredTitles;
  dom.translateCustomNames.checked = !!state.draft.translateCustomNames;
  dom.translateItemNames.checked = !!state.draft.translateItemNames;
  dom.translateLore.checked = !!state.draft.translateLore;
  dom.translateCommandOutput.checked = !!state.draft.translateCommandOutput;
  dom.skipCommandLikeText.checked = !!state.draft.skipCommandLikeText;
  dom.resourceEnabled.checked = !!state.draft.resourceEnabled;
  dom.zipPaths.value = state.draft.zipPaths || "";
  dom.sourceLangFiles.value = state.draft.sourceLangFiles || "";
  dom.targetLangFile.value = state.draft.targetLangFile || "ko_kr.json";
  dom.skipIfTargetExists.checked = !!state.draft.skipIfTargetExists;
  dom.batchSize.value = state.draft.batchSize || 40;
  dom.temperature.value = state.draft.temperature || 0.3;
  dom.rpmLimit.value = state.draft.rpmLimit || "";
  dom.tpmLimit.value = state.draft.tpmLimit || "";
  dom.backupSuffix.value = state.draft.backupSuffix || ".bak_translate";
  dom.backup.checked = !!state.draft.backup;
  dom.checkpointEnabled.checked = !!state.draft.checkpointEnabled;
  dom.continueOnFileError.checked = !!state.draft.continueOnFileError;
  dom.checkpointPath.value = state.draft.checkpointPath || "";
  dom.maxBatchRetries.value = state.draft.maxBatchRetries || 3;
  dom.maxFileWriteRetries.value = state.draft.maxFileWriteRetries || 2;
  dom.skipPatterns.value = state.draft.skipPatterns || "";
  dom.componentPrefixes.value = state.draft.componentPrefixes || "";
  dom.overrides.value = state.draft.overrides || "";
  
  const isCustom = state.draft.provider === "custom_openai" || state.draft.provider === "custom_anthropic";
  dom.customProviderSettings.classList.toggle("hidden", !isCustom);
  if (isCustom) dom.customProviderFormat.value = state.draft.provider;

  renderStaticUi();
  persistDraft();
}

function renderProviderPicker() {
  const providers = state.meta.providers || FALLBACK_META.providers;
  const current = state.draft?.provider || buildDefaultDraft().provider;
  
  const groupedProviders = [];
  let customAdded = false;
  for (const p of providers) {
    if (p.id === 'custom_openai' || p.id === 'custom_anthropic') {
      if (!customAdded) {
        groupedProviders.push({
          id: 'custom',
          label: t('providerCustom') || '기타 / Custom',
          default_base_url: '',
          env_var: 'CUSTOM_*_API_KEY'
        });
        customAdded = true;
      }
    } else {
      groupedProviders.push(p);
    }
  }

  const isCustom = current === 'custom_openai' || current === 'custom_anthropic';

  dom.providerPicker.innerHTML = groupedProviders
    .map((provider) => {
      const activeClass = (provider.id === current || (provider.id === 'custom' && isCustom)) ? "active" : "";
      return `
        <button type="button" class="provider-card ${activeClass}" data-provider-id="${escapeHtml(provider.id)}">
          <strong>${escapeHtml(provider.label)}</strong>
          <span class="provider-url">${escapeHtml(provider.default_base_url)}</span>
          <span class="provider-env">${escapeHtml(provider.env_var)}</span>
        </button>
      `;
    })
    .join("");

  dom.geminiWarning.classList.toggle("hidden", current !== "gemini");
  dom.customProviderSettings.classList.toggle("hidden", !isCustom);

  dom.providerPicker.querySelectorAll("[data-provider-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const providerId = button.dataset.providerId;
      const prev = state.draft?.provider;
      const previousDefault = providerDefaultUrl(prev);
      
      let nextProviderId = providerId;
      if (providerId === 'custom') {
        nextProviderId = dom.customProviderFormat.value || 'custom_openai';
      }
      
      const nextDefault = providerDefaultUrl(nextProviderId);
      state.draft = { ...collectDraft(), provider: nextProviderId };
      if (!dom.baseUrl.value.trim() || dom.baseUrl.value.trim() === previousDefault) {
        dom.baseUrl.value = nextDefault;
      }
      renderProviderPicker();
      updateBaseUrlHelp();
      persistDraft();
    });
  });
}

function renderTargetLanguageOptions() {
  const current = state.draft?.targetLanguagePreset || "ko";
  const options = [
    ["ko", t("targetPreset_ko")],
    ["en", t("targetPreset_en")],
    ["ja", t("targetPreset_ja")],
    ["custom", t("targetPreset_custom")],
  ];
  dom.targetLanguagePreset.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
    .join("");
  dom.targetLanguagePreset.value = current;
}

function renderStylePresetOptions() {
  const presets = state.meta.style_presets || FALLBACK_META.style_presets;
  const current = state.draft?.stylePreset || "neutral";
  dom.stylePreset.innerHTML = presets
    .map((preset) => `<option value="${preset}">${escapeHtml(t(`stylePreset_${preset}`))}</option>`)
    .join("");
  dom.stylePreset.value = presets.includes(current) ? current : "neutral";
}

function updateStylePresetHelp() {
  dom.stylePresetHelp.textContent = t(`stylePresetDesc_${dom.stylePreset.value}`);
}

function toggleCustomLanguageField() {
  dom.customLanguageField.classList.toggle("hidden", dom.targetLanguagePreset.value !== "custom");
}

function toggleResourcePanel() {
  const disabled = !dom.resourceEnabled.checked;
  dom.resourcePanel.classList.toggle("is-disabled", disabled);
  dom.resourcePanel.classList.toggle("hidden", disabled);
}

function updateBaseUrlHelp() {
  const provider = providerFromPicker();
  const meta = providerMetaById(provider);
  dom.baseUrlHelp.textContent = formatTemplate(t("baseUrlHelp"), {
    url: meta?.default_base_url || "",
    env: meta?.env_var || "",
  });
}

function providerFromPicker() {
  return state.draft?.provider || buildDefaultDraft().provider;
}

function providerMetaById(providerId) {
  return (state.meta.providers || FALLBACK_META.providers).find((item) => item.id === providerId);
}

function providerDefaultUrl(providerId) {
  return providerMetaById(providerId)?.default_base_url || "";
}

function splitLines(text) {
  return String(text || "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOverrides(text) {
  const result = {};
  String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const index = line.indexOf("=");
      if (index === -1) {
        return;
      }
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key) {
        result[key] = value;
      }
    });
  return result;
}

function buildPayload(forceDryRun, resumeFromCheckpoint = false) {
  const draft = collectDraft();
  const targetLanguage =
    draft.targetLanguagePreset === "custom"
      ? draft.customLanguage.trim()
      : TARGET_LANGUAGE_VALUES[draft.targetLanguagePreset] || "한국어";

  return {
    world_dir: draft.worldDir.trim(),
    report_path: draft.reportPath.trim(),
    dry_run: Boolean(forceDryRun),
    backup: draft.backup,
    backup_suffix: draft.backupSuffix.trim(),
    batch_size: Number(draft.batchSize) || 40,
    temperature: Number(draft.temperature) || 0.3,
    inherit_translate_py: draft.inheritTranslatePy,
    translate_py_path: draft.translatePyPath.trim(),
    api: {
      provider: draft.provider,
      api_key: draft.apiKey.trim(),
      base_url: draft.baseUrl.trim(),
      model: draft.model.trim(),
      request_timeout: Number(draft.requestTimeout) || 120,
      rpm_limit: Number(draft.rpmLimit) || 0,
      tpm_limit: Number(draft.tpmLimit) || 0,
    },
    prompt: {
      target_language: targetLanguage || "한국어",
      style_preset: draft.stylePreset,
      style_prompt: draft.stylePrompt,
      custom_system_prompt: draft.customSystemPrompt,
    },
    scan: {
      skip_patterns: splitLines(draft.skipPatterns),
      translate_signs: draft.translateSigns,
      translate_books: draft.translateBooks,
      translate_custom_names: draft.translateCustomNames,
      translate_item_names: draft.translateItemNames,
      translate_lore: draft.translateLore,
      translate_titles: draft.translateTitles,
      translate_filtered_titles: draft.translateFilteredTitles,
      translate_command_output: draft.translateCommandOutput,
      skip_command_like_text: draft.skipCommandLikeText,
      component_translate_key_prefixes: splitLines(draft.componentPrefixes),
      overrides: parseOverrides(draft.overrides),
    },
    resource_pack: {
      enabled: draft.resourceEnabled,
      zip_paths: splitLines(draft.zipPaths),
      source_lang_files: splitLines(draft.sourceLangFiles),
      target_lang_file: draft.targetLangFile.trim(),
      skip_if_target_exists: draft.skipIfTargetExists,
    },
    runtime: {
      checkpoint_enabled: draft.checkpointEnabled,
      checkpoint_path: draft.checkpointPath.trim(),
      resume_from_checkpoint: resumeFromCheckpoint,
      continue_on_file_error: draft.continueOnFileError,
      max_batch_retries: Number(draft.maxBatchRetries) || 3,
      max_file_write_retries: Number(draft.maxFileWriteRetries) || 2,
    },
  };
}

async function loadModels() {
  dom.modelCatalogStatus.textContent = t("modelCatalogLoading");
  dom.loadModelsButton.disabled = true;
  try {
    const response = await apiFetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: buildPayload(true) }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    state.modelCatalog = data.models || [];
    dom.modelCatalogStatus.textContent = formatTemplate(t("modelCatalogLoaded"), {
      count: state.modelCatalog.length,
    });
    renderModelCatalog();
  } catch (error) {
    state.modelCatalog = [];
    dom.modelCatalogStatus.textContent = formatTemplate(t("modelCatalogError"), { message: error.message });
    renderModelCatalog();
  } finally {
    dom.loadModelsButton.disabled = false;
  }
}

function renderModelCatalog() {
  const models = state.modelCatalog || [];
  const datalist = document.getElementById("modelSuggestions");
  datalist.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model.id)}"></option>`)
    .join("");

  if (!models.length) {
    dom.modelCatalog.innerHTML = `<div class="model-chip"><strong>${escapeHtml(t("modelCatalogIdle"))}</strong></div>`;
    return;
  }

  dom.modelCatalog.innerHTML = models
    .slice(0, 40)
    .map(
      (model) => `
        <button type="button" class="model-chip" data-model-id="${escapeHtml(model.id)}">
          <strong>${escapeHtml(model.display_name || model.id)}</strong>
          <span>${escapeHtml(model.id)}</span>
          <span>${escapeHtml(model.description || "")}</span>
        </button>
      `
    )
    .join("");

  dom.modelCatalog.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => {
      dom.model.value = button.dataset.modelId;
      persistDraft();
    });
  });
}

async function improveStylePrompt() {
  const brief = dom.styleBrief.value.trim();
  if (!brief) {
    dom.styleAssistStatus.textContent = t("helpStyleBrief");
    return;
  }
  dom.improveStyleButton.disabled = true;
  dom.styleAssistStatus.textContent = t("assistLoading");
  try {
    const response = await apiFetch("/api/prompt-assist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: buildPayload(true), brief }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    const current = dom.stylePrompt.value.trim();
    dom.stylePrompt.value = current ? `${current}\n\n${data.enhanced_prompt}` : data.enhanced_prompt;
    dom.styleAssistStatus.textContent = t("assistDone");
    persistDraft();
  } catch (error) {
    dom.styleAssistStatus.textContent = formatTemplate(t("assistError"), { message: error.message });
  } finally {
    dom.improveStyleButton.disabled = false;
  }
}

function applyScopePreset(preset) {
  const apply = (options) => {
    dom.translateBooks.checked = options.translateBooks;
    dom.translateSigns.checked = options.translateSigns;
    dom.translateTitles.checked = options.translateTitles;
    dom.translateFilteredTitles.checked = options.translateFilteredTitles;
    dom.translateCustomNames.checked = options.translateCustomNames;
    dom.translateItemNames.checked = options.translateItemNames;
    dom.translateLore.checked = options.translateLore;
    dom.translateCommandOutput.checked = options.translateCommandOutput;
    dom.skipCommandLikeText.checked = options.skipCommandLikeText;
  };

  if (preset === "story") {
    apply({
      translateBooks: true,
      translateSigns: true,
      translateTitles: true,
      translateFilteredTitles: true,
      translateCustomNames: true,
      translateItemNames: false,
      translateLore: false,
      translateCommandOutput: true,
      skipCommandLikeText: true,
    });
    return;
  }

  if (preset === "all") {
    apply({
      translateBooks: true,
      translateSigns: true,
      translateTitles: true,
      translateFilteredTitles: true,
      translateCustomNames: true,
      translateItemNames: true,
      translateLore: true,
      translateCommandOutput: true,
      skipCommandLikeText: true,
    });
    return;
  }

  apply({
    translateBooks: true,
    translateSigns: true,
    translateTitles: true,
    translateFilteredTitles: true,
    translateCustomNames: true,
    translateItemNames: true,
    translateLore: true,
    translateCommandOutput: true,
    skipCommandLikeText: true,
  });
}

async function submitJob(forceDryRun) {
  if (!forceDryRun && !(await requestTranslationConfirmation())) {
    return;
  }
  return startJob({
    forceDryRun,
    resumeFromCheckpoint: false,
    localEventKey: forceDryRun ? "localScanStarted" : "localTranslateStarted",
  });
}

async function resumeJob() {
  if (!(await requestTranslationConfirmation())) {
    return;
  }
  return startJob({
    forceDryRun: false,
    resumeFromCheckpoint: true,
    localEventKey: "localResumeStarted",
  });
}

async function startJob({ forceDryRun, resumeFromCheckpoint, localEventKey }) {
  setRunButtonsDisabled(true);
  try {
    const response = await apiFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: buildPayload(forceDryRun, resumeFromCheckpoint) }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    state.activeJobId = data.id;
    sessionStorage.setItem(ACTIVE_JOB_KEY, data.id);
    state.job = data;
    state.localEvents = [];
    pushLocalEvent(localEventKey);
    startPolling();
    renderMonitor();
  } catch (error) {
    pushLocalEvent("localSubmitError", { message: error.message }, true);
    setRunButtonsDisabled(false);
    renderMonitor();
  }
}

async function cancelJob() {
  if (!state.activeJobId) {
    return;
  }

  dom.cancelButton.disabled = true;
  try {
    const response = await apiFetch(`/api/jobs/${state.activeJobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    state.job = data;
    pushLocalEvent("localCancelRequested");
  } catch (error) {
    pushLocalEvent("localCancelError", { message: error.message }, true);
  } finally {
    renderMonitor();
  }
}

function startPolling() {
  stopPolling();
  pollJob();
  state.pollTimer = window.setInterval(pollJob, 1200);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollJob() {
  if (!state.activeJobId || state.pollInFlight) {
    return;
  }
  state.pollInFlight = true;
  try {
    const response = await apiFetch(`/api/jobs/${state.activeJobId}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Polling failed");
    }
    state.job = data;
    if (["completed", "failed", "cancelled"].includes(data.status)) {
      setRunButtonsDisabled(false);
      stopPolling();
      sessionStorage.removeItem(ACTIVE_JOB_KEY);
    }
    renderMonitor();
  } catch (error) {
    pushLocalEvent("localSubmitError", { message: error.message }, true);
    setRunButtonsDisabled(false);
    stopPolling();
    renderMonitor();
  } finally {
    state.pollInFlight = false;
  }
}

async function recoverActiveJob() {
  const jobId = sessionStorage.getItem(ACTIVE_JOB_KEY);
  if (!jobId) return;

  try {
    const response = await apiFetch(`/api/jobs/${jobId}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Job recovery failed");

    state.activeJobId = jobId;
    state.job = data;
    pushLocalEvent("localJobRecovered");
    if (["queued", "running"].includes(data.status)) {
      startPolling();
    } else {
      sessionStorage.removeItem(ACTIVE_JOB_KEY);
    }
    renderMonitor();
  } catch {
    sessionStorage.removeItem(ACTIVE_JOB_KEY);
  }
}

function requestTranslationConfirmation() {
  const draft = collectDraft();
  dom.confirmWorldPath.textContent = draft.worldDir.trim() || "—";
  dom.confirmBackupState.textContent = t(draft.backup ? "confirmBackupEnabled" : "confirmBackupDisabled");
  dom.confirmContinueButton.textContent = t(draft.backup ? "confirmContinue" : "translateButton");

  return new Promise((resolve) => {
    const dialog = dom.translationConfirmDialog;
    const finish = () => resolve(dialog.returnValue === "confirm");
    dialog.addEventListener("close", finish, { once: true });
    dom.confirmCancelButton.onclick = () => dialog.close("cancel");
    dom.confirmContinueButton.onclick = () => dialog.close("confirm");
    dialog.showModal();
  });
}

function setRunButtonsDisabled(disabled) {
  const status = state.job?.status || "idle";
  const running = disabled || status === "queued" || status === "running";
  const hasWorldDir = Boolean(dom.worldDir.value.trim());
  const canResume = !running && hasWorldDir && (state.job ? Boolean(state.job.can_resume) : dom.checkpointEnabled.checked);

  dom.scanButton.disabled = running;
  dom.translateButton.disabled = running;
  dom.resumeButton.disabled = !canResume;
  dom.cancelButton.disabled = !state.activeJobId || !running;
}

function exportSettings() {
  const payload = buildPayload(false);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = t("exportFilename");
  anchor.click();
  URL.revokeObjectURL(url);
  pushLocalEvent("localExported");
  renderMonitor();
}

function resetForm() {
  state.modelCatalog = [];
  populateForm(buildDefaultDraft());
  dom.modelCatalogStatus.textContent = "";
  pushLocalEvent("localReset");
  renderMonitor();
}

function pushLocalEvent(key, params = {}, error = false) {
  state.localEvents.unshift({
    timestamp: new Date().toISOString(),
    event: key,
    params,
    error,
    local: true,
  });
  state.localEvents = state.localEvents.slice(0, 20);
}

function renderMonitor() {
  const job = state.job;
  const progress = job?.progress || {
    phase: "idle",
    percent: 0,
    processed_files: 0,
    total_files: 0,
    processed_texts: 0,
    changed_file_count: 0,
    candidate_file_count: 0,
    candidate_text_count: 0,
    last_event_at: "",
    current_file: "",
    current_activity: "",
  };
  const status = job?.status || "idle";
  const running = status === "running";
  const resumable = canResumeFromState(job);
  const summary = job?.summary || buildPayload(false);
  const providerId = summary.provider || summary.api?.provider || providerFromPicker();
  const providerLabel = providerMetaById(providerId)?.label || providerId;

  setRunButtonsDisabled(false);
  dom.statusPill.textContent = statusLabel(status);
  dom.livePulse.classList.toggle("active", running);
  dom.progressNumber.textContent = `${Math.round(progress.percent || 0)}%`;
  const boundedPercent = Math.max(0, Math.min(100, progress.percent || 0));
  dom.progressBar.style.width = `${boundedPercent}%`;
  dom.progressShell.setAttribute("aria-valuenow", String(Math.round(boundedPercent)));
  dom.progressShell.setAttribute("aria-valuetext", `${Math.round(boundedPercent)}% · ${phaseLabel(progress.phase || "idle")}`);
  dom.monitorSummary.textContent = buildSummary(status, progress, job?.error || "", resumable);
  dom.runHint.textContent = runHintLabel(status, resumable);
  dom.statPhase.textContent = phaseLabel(progress.phase || "idle");
  dom.statFiles.textContent = `${progress.processed_files || 0} / ${progress.total_files || 0}`;
  dom.statTexts.textContent = String(progress.processed_texts || 0);
  dom.statChanged.textContent = String(progress.changed_file_count || job?.result?.changed_file_count || 0);
  dom.statCandidates.textContent = String(progress.candidate_text_count || job?.result?.candidate_text_count || 0);
  dom.statLastUpdate.textContent = formatRelative(progress.last_event_at);
  dom.currentProvider.textContent = providerLabel;
  dom.currentModel.textContent = summary.model || summary.api?.model || dom.model.value || "—";
  dom.currentActivity.textContent = activityLabel(progress.current_activity || progress.phase || "idle");
  dom.currentFile.textContent = progress.current_file || "—";
  dom.resultPanel.textContent = job?.result ? JSON.stringify(job.result, null, 2) : t("emptyResult");

  const timelineEvents = [
    ...(job?.events || []).map((event) => ({ ...event, local: false })),
    ...state.localEvents,
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  renderTimeline(timelineEvents.slice(0, 60));

  const candidateCount = progress.candidate_text_count || job?.result?.candidate_text_count || 0;
  if (candidateCount > 0 && status !== 'running' && status !== 'queued') {
      const estimatedTokens = candidateCount * 150;
      const tpm = Number(dom.tpmLimit.value) || 0;
      const rpm = Number(dom.rpmLimit.value) || 0;
      const batchSize = Number(dom.batchSize.value) || 40;
      
      let estSeconds = 0;
      if (tpm > 0) estSeconds = Math.max(estSeconds, (estimatedTokens / tpm) * 60);
      if (rpm > 0) estSeconds = Math.max(estSeconds, (Math.ceil(candidateCount / batchSize) / rpm) * 60);

      dom.estScale.textContent = formatTemplate(t("estimateScale"), {
        tokens: estimatedTokens.toLocaleString(),
        texts: candidateCount.toLocaleString(),
      });
      dom.estTime.textContent = estSeconds > 0
        ? formatTemplate(t("estimateTimeLimited"), { minutes: Math.max(1, Math.ceil(estSeconds / 60)) })
        : t("estimateTimeUnlimited");
  } else {
      dom.estScale.textContent = "—";
      dom.estTime.textContent = "—";
  }
}

function refreshRelativeTime() {
  if (!dom.statLastUpdate) return;
  dom.statLastUpdate.textContent = formatRelative(state.job?.progress?.last_event_at || "");
}

function renderTimeline(events) {
  if (!events.length) {
    dom.timeline.innerHTML = `<div class="timeline-item"><p>${escapeHtml(t("emptyTimeline"))}</p></div>`;
    return;
  }

  dom.timeline.innerHTML = events
    .map((event) => {
      const text = event.local ? formatLocalEvent(event) : formatServerEvent(event);
      const klass = event.error || event.event === "job_failed" ? "timeline-item error" : "timeline-item";
      return `
        <div class="${klass}">
          <time>${escapeHtml(formatTime(event.timestamp))}</time>
          <p>${escapeHtml(text)}</p>
        </div>
      `;
    })
    .join("");
}

function formatLocalEvent(event) {
  return formatTemplate(t(event.event), event.params || {});
}

function formatServerEvent(event) {
  switch (event.event) {
    case "job_started":
      return t("eventJobStarted");
    case "resource_pack_start":
      return t("eventResourcePackStart");
    case "resource_pack_done":
      return formatTemplate(t("eventResourcePackDone"), { count: event.count || 0 });
    case "scan_start":
      return formatTemplate(t("eventScanStart"), { total: event.total_files || 0 });
    case "file_start":
      return formatTemplate(t("eventFileStart"), {
        index: event.index || 0,
        total: event.total || 0,
        file: baseName(event.file),
      });
    case "file_done":
      return formatTemplate(t("eventFileDone"), {
        index: event.index || 0,
        total: event.total || 0,
        file: baseName(event.file),
        changed: event.changed_chunks || 0,
        candidates: event.candidates || 0,
      });
    case "translation_batch_start":
      return formatTemplate(t("eventBatchStart"), { count: event.batch_size || 0 });
    case "translation_batch_done":
      return formatTemplate(t("eventBatchDone"), { count: event.batch_size || 0 });
    case "translation_batch_error":
      return formatTemplate(t("eventBatchError"), { message: event.message || "" });
    case "resource_pack_skipped":
      return formatTemplate(t("eventResourcePackSkipped"), { file: baseName(event.zip_path || event.file || "") });
    case "checkpoint_loaded":
      return formatTemplate(t("eventCheckpointLoaded"), {
        files: event.completed_region_files || 0,
        packs: event.completed_resource_packs || 0,
      });
    case "checkpoint_ignored":
      return t("eventCheckpointIgnored");
    case "file_error":
      return formatTemplate(t("eventFileError"), { message: event.message || "" });
    case "file_write_retry":
      return formatTemplate(t("eventWriteRetry"), { message: event.message || "" });
    case "job_cancel_requested":
      return t("eventCancelRequested");
    case "cancelled":
      return t("eventCancelled");
    case "fatal_error":
      return formatTemplate(t("eventFatalError"), { message: event.message || "" });
    case "done":
      return formatTemplate(t("eventDone"), {
        changed: event.changed_file_count || 0,
        candidates: event.candidate_text_count || 0,
      });
    case "job_cancelled":
      return t("eventCancelled");
    case "job_completed":
      return t("eventCompleted");
    case "job_failed":
      return formatTemplate(t("eventFailed"), { message: event.message || "" });
    default:
      return formatTemplate(t("eventUnknown"), { event: event.event });
  }
}

function buildSummary(status, progress, errorMessage, resumable) {
  switch (status) {
    case "queued":
      return t("summaryQueued");
    case "running":
      return t("summaryRunning");
    case "cancelled":
      return t("summaryCancelled");
    case "completed":
      return formatTemplate(t("summaryCompleted"), {
        changed: progress.changed_file_count || 0,
        candidates: progress.candidate_text_count || 0,
      });
    case "failed":
      return errorMessage ? `${t("summaryFailed")} ${errorMessage}`.trim() : t("summaryFailed");
    default:
      return t("summaryIdle");
  }
}

function statusLabel(status) {
  switch (status) {
    case "queued":
      return t("statusQueued");
    case "running":
      return t("statusRunning");
    case "completed":
      return t("statusCompleted");
    case "cancelled":
      return t("statusCancelled");
    case "failed":
      return t("statusFailed");
    default:
      return t("statusIdle");
  }
}

function phaseLabel(phase) {
  switch (phase) {
    case "queued":
      return t("phaseQueued");
    case "preparing":
      return t("phasePreparing");
    case "resource_pack":
      return t("phaseResourcePack");
    case "scan_pending":
      return t("phaseScanPending");
    case "scan":
      return t("phaseScan");
    case "translate":
      return t("phaseTranslate");
    case "cancelled":
      return t("phaseCancelled");
    case "done":
      return t("phaseDone");
    case "failed":
      return t("phaseFailed");
    default:
      return t("phaseIdle");
  }
}

function activityLabel(activity) {
  switch (activity) {
    case "preparing":
      return t("activityPreparing");
    case "resource_pack":
    case "resource_pack_start":
      return t("activityResourcePack");
    case "scan_start":
      return t("activityScanStart");
    case "file_start":
      return t("activityFileStart");
    case "file_done":
      return t("activityFileDone");
    case "translation_batch_start":
      return t("activityBatchStart");
    case "translation_batch_done":
      return t("activityBatchDone");
    case "translation_batch_error":
      return t("activityBatchError");
    case "resource_pack_skipped":
      return t("activityResourcePackSkipped");
    case "checkpoint_loaded":
      return t("activityCheckpointLoaded");
    case "file_error":
      return t("activityFileError");
    case "file_write_retry":
      return t("activityFileWriteRetry");
    case "cancel_requested":
    case "job_cancel_requested":
      return t("activityCancelRequested");
    case "cancelled":
      return t("activityCancelled");
    case "done":
      return t("activityDone");
    case "failed":
    case "fatal_error":
      return t("activityFailed");
    default:
      return phaseLabel(activity);
  }
}

function canResumeFromState(job) {
  if (job) {
    return Boolean(job.can_resume);
  }
  return Boolean(dom.worldDir.value.trim()) && dom.checkpointEnabled.checked;
}

function runHintLabel(status, resumable) {
  switch (status) {
    case "running":
    case "queued":
      return t("runHintRunning");
    case "cancelled":
      return t("runHintCancelled");
    case "failed":
      return resumable ? t("runHintFailed") : t("runHintReady");
    case "completed":
      return resumable ? t("runHintResume") : t("runHintReady");
    case "idle":
    default:
      return resumable ? t("runHintResume") : dom.worldDir.value.trim() ? t("runHintReady") : t("runHintIdle");
  }
}

function formatRelative(iso) {
  if (!iso) {
    return "—";
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSeconds < 5) {
    return t("relativeNow");
  }
  if (diffSeconds < 60) {
    return formatTemplate(t("relativeSeconds"), { count: diffSeconds });
  }
  return formatTemplate(t("relativeMinutes"), { count: Math.floor(diffSeconds / 60) });
}

function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat(state.lang, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function baseName(path) {
  return String(path || "").split("/").pop() || String(path || "");
}

function t(key) {
  return I18N[state.lang]?.[key] ?? I18N.ko[key] ?? key;
}

function formatTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
