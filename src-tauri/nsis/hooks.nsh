; UTF-8 BOM: makensis decodes BOM-less files as ANSI.
!include "${__FILEDIR__}\ui.nsh"

Var PrudiiBackup
Var PrudiiBackupYes

; Inserted by installer.nsi among the uninstaller pages, ahead of the confirm page.
!macro PRUDII_BACKUP_PAGE
  UninstPage custom un.PrudiiBackupPage un.PrudiiBackupLeave

  Function un.PrudiiBackupPage
    ; Updates and passive runs must never block on a prompt; silent runs skip pages anyway.
    ${If} $UpdateMode = 1
    ${OrIf} $PassiveMode = 1
      Abort
    ${EndIf}
    !insertmacro PRUDII_SAVE
    ; $LANGUAGE only reflects the languages this uninstaller loaded (English only), so
    ; the page language comes from Windows instead.
    System::Call 'kernel32::GetUserDefaultUILanguage() i .r1'
    IntOp $1 $1 & 0x3FF
    ${If} $1 = 7
      StrCpy $2 "Daten sichern"
      StrCpy $3 "Konten, E-Mails und Aufgaben auf einen anderen Computer mitnehmen."
      StrCpy $4 "Prudii Mail kann vor der Deinstallation ein Backup Ihrer Konten, E-Mails und Aufgaben erstellen, das Sie auf einem anderen Computer importieren können."
      StrCpy $5 "Zuerst ein Backup erstellen"
      StrCpy $6 "Ohne Backup deinstallieren"
    ${Else}
      StrCpy $2 "Back Up Your Data"
      StrCpy $3 "Take your accounts, mail and tasks to another computer."
      StrCpy $4 "Prudii Mail can create a backup of your accounts, mail and tasks before it is removed. You can import it on another computer."
      StrCpy $5 "Create a backup first"
      StrCpy $6 "Uninstall without a backup"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$2" "$3"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 24u "$4"
    Pop $1
    ${NSD_CreateRadioButton} 30u 50u -30u 10u "$5"
    Pop $PrudiiBackupYes
    ${NSD_CreateRadioButton} 30u 70u -30u 10u "$6"
    Pop $1
    ${If} $PrudiiBackup == "0"
      SendMessage $1 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $PrudiiBackupYes ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}
    Push $0
    Call un.PrudiiDarkPage
    !insertmacro PRUDII_RESTORE
    nsDialogs::Show
  FunctionEnd

  Function un.PrudiiBackupLeave
    ${NSD_GetState} $PrudiiBackupYes $PrudiiBackup
  FunctionEnd
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $PrudiiBackup = 1
    ; Close the running app now so the exported backup reflects the current DB state.
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --export-backup'
  ${EndIf}
!macroend
