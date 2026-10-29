; Dark theme for the MUI2 wizard in installer.nsi (installer and uninstaller).
; Native controls only render dark through uxtheme's undocumented dark mode, and themed
; check boxes and radio buttons ignore WM_CTLCOLOR text colors, so their captions are
; drawn by a label on top; static labels are transparent to clicks, which reach the control.

SetFont "Segoe UI" 9

!define PRUDII_BG    15121D
!define PRUDII_LINE  2A2633
!define PRUDII_TEXT  ECE8F4
!define PRUDII_BODY  BDB6CC
!define PRUDII_MUTED A9A2B9
!define PRUDII_DIM   6F6880
!define PRUDII_FIELD 0F0D14

!define MUI_BGCOLOR ${PRUDII_BG}
!define MUI_TEXTCOLOR FFFFFF
!define MUI_HEADERIMAGE_RIGHT
!define MUI_INSTFILESPAGE_COLORS "${PRUDII_TEXT} ${PRUDII_FIELD}"
!define MUI_CUSTOMFUNCTION_GUIINIT PrudiiGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.PrudiiGuiInit

Var PrudiiDark
Var PrudiiInner
Var PrudiiAllowDark
Var PrudiiHeaderLine

!macro PRUDII_SAVE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
!macroend

!macro PRUDII_RESTORE
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Helpers pass values in registers; only the page entry points save them.
!macro PRUDII_UI_FUNCTIONS UN
  ; in: $0 control, $1 parent. out: $4 x, $5 y, $6 width, $7 height in $1's client pixels
  Function ${UN}PrudiiRect
    System::Call '*(i 0, i 0, i 0, i 0) p .r3'
    System::Call 'user32::GetWindowRect(p r0, p r3) i'
    System::Call 'user32::MapWindowPoints(p 0, p r1, p r3, i 2) i'
    System::Call '*$3(i .r4, i .r5, i .r6, i .r7)'
    System::Free $3
    IntOp $6 $6 - $4
    IntOp $7 $7 - $5
  FunctionEnd

  ; in: $0 font source, $1 parent, $2 text, $4..$7 rect. out: $3 label above its siblings
  Function ${UN}PrudiiLabel
    System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w r2, i 0x50004200, i r4, i r5, i r6, i r7, p r1, p 0, p 0, p 0) p .r3'
    SendMessage $0 ${WM_GETFONT} 0 0 $2
    SendMessage $3 ${WM_SETFONT} $2 1
    System::Call 'user32::SetWindowPos(p r3, p 0, i 0, i 0, i 0, i 0, i 0x13) i'
  FunctionEnd

  ; in: $0 control
  Function ${UN}PrudiiTheme
    ${If} $PrudiiAllowDark P<> 0
      System::Call "::$PrudiiAllowDark(p r0, i 1) i"
    ${EndIf}
    System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0) i'
    SendMessage $0 ${WM_THEMECHANGED} 0 0
  FunctionEnd

  ; in: $0 check box or radio button, $1 parent
  Function ${UN}PrudiiCaption
    System::Call 'user32::GetWindowText(p r0, w .r2, i ${NSIS_MAX_STRLEN}) i'
    StrCmp $2 "" done
    SendMessage $0 ${WM_SETTEXT} 0 "STR:"
    Call ${UN}PrudiiRect
    System::Call 'user32::GetDpiForWindow(p r0) i .r3'
    IntOp $3 $3 * 18
    IntOp $3 $3 / 96
    IntOp $4 $4 + $3
    IntOp $6 $6 - $3
    Call ${UN}PrudiiLabel
    System::Call 'user32::IsWindowEnabled(p r0) i .r2'
    ${If} $2 = 0
      SetCtlColors $3 ${PRUDII_DIM} ${PRUDII_BG}
    ${Else}
      SetCtlColors $3 ${PRUDII_TEXT} ${PRUDII_BG}
    ${EndIf}
    done:
  FunctionEnd

  ; in: $0 group box, $1 parent. The themed frame stays light, so only its caption remains.
  Function ${UN}PrudiiGroup
    System::Call 'user32::GetWindowText(p r0, w .r2, i ${NSIS_MAX_STRLEN}) i'
    Call ${UN}PrudiiRect
    ShowWindow $0 ${SW_HIDE}
    System::Call 'user32::GetDpiForWindow(p r0) i .r3'
    IntOp $7 $3 * 16
    IntOp $7 $7 / 96
    Call ${UN}PrudiiLabel
    SetCtlColors $3 ${PRUDII_MUTED} ${PRUDII_BG}
  FunctionEnd

  ; in: $1 page dialog
  Function ${UN}PrudiiChildren
    StrCpy $8 0
    loop:
      FindWindow $8 "" "" $1 $8
      IntCmp $8 0 done
      StrCpy $0 $8
      System::Call 'user32::GetClassName(p r0, w .r2, i 64) i'
      ${If} $2 == "Button"
        System::Call 'user32::GetWindowLong(p r0, i -16) i .r9'
        IntOp $9 $9 & 0xF
        ${If} $9 = 7
          Call ${UN}PrudiiGroup
        ${Else}
          Call ${UN}PrudiiTheme
          SetCtlColors $0 ${PRUDII_TEXT} ${PRUDII_BG}
          ${If} $9 > 1
            Call ${UN}PrudiiCaption
          ${EndIf}
        ${EndIf}
      ${ElseIf} $2 == "Edit"
        System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_DarkTheme", p 0) i'
        SetCtlColors $0 FFFFFF ${PRUDII_FIELD}
      ${ElseIf} $2 == "msctls_progress32"
        ; bar colors only apply to an unthemed progress bar
        System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "") i'
        SendMessage $0 0x0409 0 0x009A55E0
        SendMessage $0 0x2001 0 0x002A1F22
      ${ElseIf} $2 == "SysListView32"
        System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0) i'
      ${ElseIf} $2 == "Static"
      ${AndIf} $PrudiiInner = 1
        SetCtlColors $0 ${PRUDII_TEXT} ${PRUDII_BG}
      ${EndIf}
      Goto loop
    done:
  FunctionEnd

  ; out: $1 newest inner page; at SHOW time the previous page's dialog can still exist
  Function ${UN}PrudiiPage
    StrCpy $1 0
    StrCpy $9 0
    page_loop:
      FindWindow $9 "#32770" "" $HWNDPARENT $9
      IntCmp $9 0 page_done
      StrCpy $1 $9
      Goto page_loop
    page_done:
  FunctionEnd

  ; MUI re-shows its etched separators and branding text on every page change
  Function ${UN}PrudiiChrome
    GetDlgItem $9 $HWNDPARENT 1035
    ShowWindow $9 ${SW_HIDE}
    GetDlgItem $9 $HWNDPARENT 1036
    ShowWindow $9 ${SW_HIDE}
    GetDlgItem $9 $HWNDPARENT 1045
    ShowWindow $9 ${SW_HIDE}
    GetDlgItem $9 $HWNDPARENT 1256
    ShowWindow $9 ${SW_HIDE}
    GetDlgItem $9 $HWNDPARENT 1028
    ShowWindow $9 ${SW_HIDE}
    ${If} $PrudiiInner = 1
      ShowWindow $PrudiiHeaderLine ${SW_SHOW}
    ${Else}
      ShowWindow $PrudiiHeaderLine ${SW_HIDE}
    ${EndIf}
  FunctionEnd

  Function ${UN}PrudiiGuiInit
    !insertmacro PRUDII_SAVE
    ; uxtheme's dark mode ordinals exist from Windows 10 1809 (build 17763)
    System::Call '*(i 276, i 0, i 0, i 0, i 0, i 0, &w128 "") p .r0'
    System::Call 'ntdll::RtlGetVersion(p r0) i'
    System::Call '*$0(i, i, i, i .r1)'
    System::Free $0
    ${If} $1 >= 17763
      StrCpy $PrudiiDark 1
      System::Call 'kernel32::LoadLibrary(w "uxtheme.dll") p .r0'
      ; 135 = SetPreferredAppMode, 133 = AllowDarkModeForWindow
      System::Call 'kernel32::GetProcAddress(p r0, p 135) p .r1'
      ${If} $1 P<> 0
        System::Call "::$1(i 2) i"
      ${EndIf}
      System::Call 'kernel32::GetProcAddress(p r0, p 133) p .r1'
      StrCpy $PrudiiAllowDark $1
      ${If} $PrudiiAllowDark P<> 0
        System::Call "::$PrudiiAllowDark(p $HWNDPARENT, i 1) i"
      ${EndIf}
      ; dark caption; caption and caption text colors only take effect on Windows 11
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x001D1215, i 4) i'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x00F4E8EC, i 4) i'

      SetCtlColors $HWNDPARENT ${PRUDII_TEXT} ${PRUDII_BG}
      ${For} $2 1 3
        GetDlgItem $0 $HWNDPARENT $2
        Call ${UN}PrudiiTheme
        SetCtlColors $0 ${PRUDII_TEXT} ${PRUDII_BG}
      ${Next}
      GetDlgItem $0 $HWNDPARENT 1038
      SetCtlColors $0 ${PRUDII_MUTED} ${PRUDII_BG}

      StrCpy $1 $HWNDPARENT
      StrCpy $2 ""
      GetDlgItem $0 $HWNDPARENT 1036
      Call ${UN}PrudiiRect
      StrCpy $7 1
      Call ${UN}PrudiiLabel
      SetCtlColors $3 "" ${PRUDII_LINE}
      StrCpy $PrudiiHeaderLine $3
      StrCpy $2 ""
      GetDlgItem $0 $HWNDPARENT 1045
      Call ${UN}PrudiiRect
      StrCpy $7 1
      Call ${UN}PrudiiLabel
      SetCtlColors $3 "" ${PRUDII_LINE}

      ; product and version next to the buttons instead of MUI's branding on the separator
      GetDlgItem $0 $HWNDPARENT 1
      Call ${UN}PrudiiRect
      StrCpy $8 $5
      StrCpy $9 $7
      GetDlgItem $0 $HWNDPARENT 1028
      Call ${UN}PrudiiRect
      StrCpy $5 $8
      StrCpy $7 $9
      IntOp $6 $6 / 2
      StrCpy $2 "${PRODUCTNAME} ${VERSION}"
      Call ${UN}PrudiiLabel
      SetCtlColors $3 ${PRUDII_DIM} ${PRUDII_BG}
    ${EndIf}
    !insertmacro PRUDII_RESTORE
  FunctionEnd

  ; MUI_PAGE_CUSTOMFUNCTION_SHOW for pages with MUI's header
  Function ${UN}PrudiiInnerShow
    ${If} $PrudiiDark = 1
      !insertmacro PRUDII_SAVE
      StrCpy $PrudiiInner 1
      Call ${UN}PrudiiChrome
      Call ${UN}PrudiiPage
      SetCtlColors $1 ${PRUDII_TEXT} ${PRUDII_BG}
      Call ${UN}PrudiiChildren
      !insertmacro PRUDII_RESTORE
    ${EndIf}
  FunctionEnd

  ; For nsDialogs pages: push the dialog, call before nsDialogs::Show
  Function ${UN}PrudiiDarkPage
    Exch $1
    ${If} $PrudiiDark = 1
      !insertmacro PRUDII_SAVE
      StrCpy $PrudiiInner 1
      Call ${UN}PrudiiChrome
      SetCtlColors $1 ${PRUDII_TEXT} ${PRUDII_BG}
      Call ${UN}PrudiiChildren
      !insertmacro PRUDII_RESTORE
    ${EndIf}
    Pop $1
  FunctionEnd
!macroend

!macro PRUDII_UI
  !insertmacro PRUDII_UI_FUNCTIONS ""
  !insertmacro PRUDII_UI_FUNCTIONS "un."

  ; MUI_PAGE_CUSTOMFUNCTION_SHOW for the welcome and finish pages
  Function PrudiiSidebarShow
    ${If} $PrudiiDark = 1
      !insertmacro PRUDII_SAVE
      StrCpy $PrudiiInner 0
      Call PrudiiChrome
      Call PrudiiPage
      ; MUI creates image, title and body text in that order
      StrCpy $8 0
      StrCpy $9 0
      body_loop:
        FindWindow $8 "Static" "" $1 $8
        IntCmp $8 0 body_done
        IntOp $9 $9 + 1
        IntCmp $9 3 0 body_loop body_loop
        SetCtlColors $8 ${PRUDII_BODY} ${PRUDII_BG}
      body_done:
      Call PrudiiChildren
      !insertmacro PRUDII_RESTORE
    ${EndIf}
  FunctionEnd
!macroend
