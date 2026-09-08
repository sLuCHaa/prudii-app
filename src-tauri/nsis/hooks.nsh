; UTF-8 BOM: makensis decodes BOM-less files as ANSI.
!macro NSIS_HOOK_PREUNINSTALL
  ; Updates and silent/passive runs must never block on a prompt.
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
    ; Close the running app now so the exported backup reflects the current DB state.
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

    ; $LANGUAGE only reflects the languages this installer loaded (English only), so
    ; the prompt language comes from Windows instead.
    System::Call 'kernel32::GetUserDefaultUILanguage() i .r1'
    IntOp $1 $1 & 0x3FF
    ${If} $1 = 7
      StrCpy $0 "Möchten Sie vor der Deinstallation ein Backup (Konten, E-Mails, Aufgaben) für einen anderen Computer erstellen?"
    ${Else}
      StrCpy $0 "Create a backup (accounts, mail, tasks) for another computer before uninstalling?"
    ${EndIf}

    MessageBox MB_YESNO|MB_ICONQUESTION "$0" IDNO backup_hook_skip
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --export-backup'
    backup_hook_skip:
  ${EndIf}
!macroend
