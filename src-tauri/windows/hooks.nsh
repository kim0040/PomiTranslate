; Tauri NSIS hooks (bundle.windows.nsis.installerHooks).

; Shown when "Delete the application data" could not finish (Korean, English, Japanese).
LangString pomiResetIncomplete 1042 "PomiTranslate 데이터 일부를 지우지 못했습니다. 월드 백업은 그대로입니다. 남은 파일은 직접 지울 수 있습니다:$\r$\n$APPDATA\PomiTranslate"
LangString pomiResetIncomplete 1033 "Some PomiTranslate data could not be deleted. World backups were kept. You can delete what is left yourself:$\r$\n$APPDATA\PomiTranslate"
LangString pomiResetIncomplete 1041 "PomiTranslate のデータの一部を削除できませんでした。ワールドのバックアップは残っています。残りは手動で削除できます:$\r$\n$APPDATA\PomiTranslate"

; The installer picks its language from the system (displayLanguageSelector is off) but the template
; saves the choice only from the language selector. Without the saved value the uninstaller asks
; "Please select a language" in English before anything else, so the install records it here.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}" $LANGUAGE
!macroend

; The uninstaller's "Delete the application data" box removes the shell's folders
; ($APPDATA and $LOCALAPPDATA \${BUNDLEID}: key vault, reports, logs, WebView data). The translation
; core of the production app keeps its own folder, $APPDATA\PomiTranslate (mwt/userdata.py,
; src-tauri/src/sidecar_paths.rs). With the box ticked, the installed core runs the same reset as
; Settings > Reset on it (`--reset-user-data`): settings, model lists, scans, unfinished jobs and
; review drafts go; world backups, state counters, copies of damaged settings and locks stay, and a
; link inside the folder is removed as a link, never followed.
;
; Order: the app must be stopped first. The template asks about a running app only after this hook,
; and a Cancel there aborts the uninstall, so the same check runs here before anything is deleted.
; The reset runs while the program files still exist. If the core is missing or fails, nothing more
; is deleted and the person is told what is left. An update (/UPDATE) never clears anything, and a
; build with another identifier keeps its core data inside its own ${BUNDLEID} folder, which the
; template already removes, so it never touches this one.
!macro NSIS_HOOK_PREUNINSTALL
  !if "${BUNDLEID}" == "app.pomitranslate.desktop"
    ${If} $DeleteAppDataCheckboxState = 1
    ${AndIf} $UpdateMode <> 1
      SetShellVarContext current
      ${If} ${FileExists} "$APPDATA\PomiTranslate\*.*"
      ${AndIf} ${FileExists} "$INSTDIR\pomi-sidecar\pomi-sidecar.exe"
        !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
        Push $0
        nsExec::Exec '"$INSTDIR\pomi-sidecar\pomi-sidecar.exe" --reset-user-data --data-dir "$APPDATA\PomiTranslate"'
        Pop $0
        DetailPrint "PomiTranslate data reset: $0"
        ${If} $0 != 0
          IfSilent +2
          MessageBox MB_OK|MB_ICONEXCLAMATION "$(pomiResetIncomplete)"
        ${EndIf}
        Pop $0
      ${EndIf}
    ${EndIf}
  !endif
!macroend
