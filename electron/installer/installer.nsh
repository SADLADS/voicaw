; The Windows installer's look (builder.config.js `nsis.include`): instead of electron-builder's
; grey "Installing, please wait" box, a borderless window like the app's splash (splash.bmp, drawn
; from assets/splash.html by render-art.mjs), a line saying what it's doing and a slim progress
; bar. Updates (quitAndInstall) run the same installer, so they look the same.
;
; It hangs off electron-builder's one-click template (app-builder-lib/templates/nsis): the
; install page's show function restyles NSIS's window before installing starts, and
; customCheckAppRunning, which the template runs just after showing its SpiderBanner box, hides
; that box again and does the template's own check. Check it still works after upgrading
; electron-builder (README "Desktop app", trying the installer under wine).

!ifndef BUILD_UNINSTALLER

!include LogicLib.nsh

; Our own pixels, sharp at any scale (1x or 2x art below).
ManifestDPIAware true

; The page this applies to is the template's first and only one (MUI_PAGE_INSTFILES).
!define MUI_PAGE_CUSTOMFUNCTION_SHOW voicawSplashShow

; At 1x; the 2x art doubles it all.
; This file's folder (the art), while it's known.
!define VOICAW_ART_DIR "${__FILEDIR__}"

!define VOICAW_WIDTH 300
!define VOICAW_HEIGHT 340
!define VOICAW_CORNER 28 ; the ellipse's diameter: a 14 px radius, as the splash
!define VOICAW_TEXT_TOP 214 ; the splash's line (render-art.mjs prints it)
!define VOICAW_TEXT_HEIGHT 22
!define VOICAW_BAR_TOP 246
!define VOICAW_BAR_WIDTH 160
!define VOICAW_BAR_HEIGHT 4

Var voicawScale
; Kept for voicawAfterSpiderBanner: the page, and the window's place and size.
Var voicawPage
Var voicawX
Var voicawY
Var voicawW
Var voicawH

; Puts the window in its place, with its rounded corners (clobbers $5 to $8).
!macro voicawPlaceWindow
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $voicawX, i $voicawY, i $voicawW, i $voicawH, i 0x0024)' ; SWP_NOZORDER | SWP_FRAMECHANGED
  IntOp $5 $voicawW + 1
  IntOp $6 $voicawH + 1
  IntOp $7 ${VOICAW_CORNER} * $voicawScale
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r5, i r6, i r7, i r7) p .r8'
  System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p r8, i 1)'
!macroend

; The page's progress bar: flat, the app's purple on its raised grey (clobbers $2, $5 to $8).
!macro voicawStyleBar
  GetDlgItem $2 $voicawPage 1004
  System::Call 'uxtheme::SetWindowTheme(p r2, w " ", w " ")' ; no such theme: classic drawing, our colours ("" would be NULL, the default)
  System::Call 'user32::SetWindowLong(p r2, i -16, i 0x50000001)' ; WS_CHILD | WS_VISIBLE | PBS_SMOOTH, no border
  System::Call 'user32::SetWindowLong(p r2, i -20, i 0)'
  SendMessage $2 0x409 0 0x00C9526A ; PBM_SETBARCOLOR #6a52c9
  SendMessage $2 0x2001 0 0x0033262A ; PBM_SETBKCOLOR #2a2633
  IntOp $5 ${VOICAW_BAR_WIDTH} * $voicawScale
  IntOp $6 $voicawW - $5
  IntOp $6 $6 / 2
  IntOp $7 ${VOICAW_BAR_TOP} * $voicawScale
  IntOp $8 ${VOICAW_BAR_HEIGHT} * $voicawScale
  System::Call 'user32::SetWindowPos(p r2, p 0, i r6, i r7, i r5, i r8, i 0x0024)'
!macroend

; Hides every child of $0 except $1.
!macro voicawHideChildrenExcept
  System::Call 'user32::GetWindow(p r0, i 5) p .r2' ; GW_CHILD
  ${DoWhile} $2 != 0
    ${If} $2 != $1
      ShowWindow $2 0 ; SW_HIDE (WinMessages.nsh comes later)
    ${EndIf}
    System::Call 'user32::GetWindow(p r2, i 2) p .r2' ; GW_HWNDNEXT
  ${Loop}
!macroend

; Defined from the template's customHeader: this file is read before the plugins it uses are known.
!macro customHeader
Function voicawSplashShow
  InitPluginsDir
  ; 2x art from 150% up; below that 1x (smaller than the splash at 125%, but sharp).
  System::Call 'user32::GetDC(p 0) p .r1'
  System::Call 'gdi32::GetDeviceCaps(p r1, i 88) i .r0' ; LOGPIXELSX: the screen's DPI
  System::Call 'user32::ReleaseDC(p 0, p r1)'
  ${If} $0 >= 144
    StrCpy $voicawScale 2
    File /oname=$PLUGINSDIR\voicaw-splash.bmp "${VOICAW_ART_DIR}\splash@2x.bmp"
  ${Else}
    StrCpy $voicawScale 1
    File /oname=$PLUGINSDIR\voicaw-splash.bmp "${VOICAW_ART_DIR}\splash.bmp"
  ${EndIf}
  IntOp $3 ${VOICAW_WIDTH} * $voicawScale
  IntOp $4 ${VOICAW_HEIGHT} * $voicawScale

  ; The window: no frame, rounded, in the middle of the screen, still on the taskbar.
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -16, i 0x86000000)' ; WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i 0x00040000)' ; WS_EX_APPWINDOW
  System::Call 'user32::GetSystemMetrics(i 0) i .r5'
  System::Call 'user32::GetSystemMetrics(i 1) i .r6'
  IntOp $5 $5 - $3
  IntOp $5 $5 / 2
  IntOp $6 $6 - $4
  IntOp $6 $6 / 2
  StrCpy $voicawX $5
  StrCpy $voicawY $6
  StrCpy $voicawW $3
  StrCpy $voicawH $4
  !insertmacro voicawPlaceWindow

  ; Only the page shows, filling the window, and of the page only its progress bar.
  FindWindow $1 "#32770" "" $HWNDPARENT
  StrCpy $0 $HWNDPARENT
  !insertmacro voicawHideChildrenExcept
  System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i r3, i r4, i 0x0004)'
  StrCpy $0 $1
  GetDlgItem $1 $0 1004
  !insertmacro voicawHideChildrenExcept
  StrCpy $9 $0 ; the page
  StrCpy $voicawPage $0

  ; The picture, under everything.
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 0, i r3, i r4, p r9, p 0, p 0, p 0) p .r2' ; WS_CHILD | WS_VISIBLE | SS_BITMAP
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\voicaw-splash.bmp", i 0, i 0, i 0, i 0x10) p .r5' ; IMAGE_BITMAP, LR_LOADFROMFILE
  SendMessage $2 0x172 0 $5 ; STM_SETIMAGE
  System::Call 'user32::SetWindowPos(p r2, p 1, i 0, i 0, i 0, i 0, i 0x0013)' ; HWND_BOTTOM

  ; The line, in the splash's type.
  ${If} ${isUpdated}
    StrCpy $6 "Installing update"
  ${Else}
    StrCpy $6 "Installing ${PRODUCT_NAME}"
  ${EndIf}
  IntOp $7 ${VOICAW_TEXT_TOP} * $voicawScale
  IntOp $8 ${VOICAW_TEXT_HEIGHT} * $voicawScale
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "$6", i 0x50000001, i 0, i r7, i r3, i r8, p r9, p 0, p 0, p 0) p .r2' ; SS_CENTER
  IntOp $5 -15 * $voicawScale
  System::Call 'gdi32::CreateFont(i r5, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI") p .r5' ; semibold, ClearType
  SendMessage $2 0x0030 $5 1 ; WM_SETFONT
  SetCtlColors $2 0xEFEDF5 transparent

  !insertmacro voicawStyleBar
FunctionEnd
!macroend

; Runs in the install section just after the template's SpiderBanner::Show (a box of its own):
; hide that and bring ours back, then the template's check that the app isn't running.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro voicawAfterSpiderBanner
  !ifdef VOICAW_SKIP_APP_CHECK ; trying the installer under wine, whose process list fools it
    ${If} 0 = 1
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifdef VOICAW_SKIP_APP_CHECK
    ${EndIf}
  !endif
!macroend

!macro voicawSaveRegisters
  Push $0
  Push $1
  Push $2
  Push $5
  Push $6
  Push $7
  Push $8
!macroend
!macro voicawRestoreRegisters
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $2
  Pop $1
  Pop $0
!macroend

; SpiderBanner shrinks the window to a banner and puts its own box in it: undo both.
!macro voicawAfterSpiderBanner
  ${If} $voicawPage != "" ; not a silent install
    !insertmacro voicawSaveRegisters
    StrCpy $0 $HWNDPARENT
    StrCpy $1 $voicawPage
    !insertmacro voicawHideChildrenExcept
    ShowWindow $voicawPage 5 ; SW_SHOW
    !insertmacro voicawPlaceWindow
    !insertmacro voicawStyleBar
    !insertmacro voicawRestoreRegisters
  ${EndIf}
!macroend

!endif
