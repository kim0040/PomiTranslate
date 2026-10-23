; Tauri NSIS hooks (bundle.windows.nsis.installerHooks).
;
; The uninstaller's "Delete the application data" box removes the shell's folders
; ($APPDATA and $LOCALAPPDATA \app.pomitranslate.desktop: key vault, reports, logs, WebView data).
; The translation core keeps its own folder, $APPDATA\PomiTranslate (mwt/userdata.py). With the box
; ticked, this hook also clears there what the in-app reset clears (RESET_FILES / RESET_DIRS in
; mwt/userdata.py): settings, model lists, scans, unfinished jobs and review drafts. World backups,
; the per-world state counters, copies of damaged settings and the lock files stay, as with the
; reset: a backup can be the only way back to a world's earlier state. An update (/UPDATE) never
; clears anything.

; The installer picks its language from the system (displayLanguageSelector is off) but the template
; saves the choice only from the language selector. Without the saved value the uninstaller asks
; "Please select a language" in English before anything else, so the install records it here.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr ${MUI_LANGDLL_REGISTRY_ROOT} "${MUI_LANGDLL_REGISTRY_KEY}" "${MUI_LANGDLL_REGISTRY_VALUENAME}" $LANGUAGE
!macroend

; Remove one folder of the core's data. A link (junction or symbolic link) is removed as a link and
; never followed, like the reset does.
!macro POMI_REMOVE_CORE_DIR NAME
  StrCpy $0 "$APPDATA\PomiTranslate\${NAME}"
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r1'
  ${If} $1 <> -1
    IntOp $1 $1 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
    ${If} $1 <> 0
      RMDir "$0"
    ${Else}
      RMDir /r "$0"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Push $0
    Push $1
    SetShellVarContext current
    Delete "$APPDATA\PomiTranslate\settings.json"
    Delete "$APPDATA\PomiTranslate\settings.backup.json"
    Delete "$APPDATA\PomiTranslate\settings.json.tmp"
    Delete "$APPDATA\PomiTranslate\settings.backup.json.tmp"
    !insertmacro POMI_REMOVE_CORE_DIR "models"
    !insertmacro POMI_REMOVE_CORE_DIR "scans"
    !insertmacro POMI_REMOVE_CORE_DIR "jobs"
    !insertmacro POMI_REMOVE_CORE_DIR "review-drafts"
    Pop $1
    Pop $0
  ${EndIf}
!macroend
