; WitBox Windows installer (NSIS 3, Modern UI 2). Build with ./build.sh, which passes:
;   /DVERSION=1.1.0  /DAPP_EXE=<WitBox-windows-x64.exe>  /DICON=<icon.ico>
;   /DWELCOME_BMP=<164x314 bmp>  /DHEADER_BMP=<150x57 bmp>  /DOUTFILE=<WitBox-Setup.exe>
;   /DSERVER_DIR=<dir>   only when install-server.ps1, install.sh and
;                        witbox-linux-x86_64.tar.gz all exist there (adds the server component)
;   /DARCH=x86-unicode | amd64-unicode   (stub; default x86-unicode)
;
; Per-user install, no administrator rights: %LOCALAPPDATA%\Programs\WitBox, HKCU only.

Unicode true
!ifndef ARCH
  !define ARCH "x86-unicode"
!endif
Target ${ARCH}
SetCompressor /SOLID lzma
ManifestDPIAware true
ManifestSupportedOS all
RequestExecutionLevel user

!ifndef VERSION
  !define VERSION "1.1.0"
!endif
!define PRODUCT   "WitBox"
!define PUBLISHER "Avi Twil"
!define EXE_NAME  "WitBox.exe"
!define ARP_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\WitBox"
!define RUN_KEY   "Software\Microsoft\Windows\CurrentVersion\Run"
!define SETUP_KEY "Software\WitBox\Setup"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\WitBox"
InstallDirRegKey HKCU "${SETUP_KEY}" "InstallDir"
BrandingText "${PRODUCT} ${VERSION} · Created by ${PUBLISHER}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIFileVersion    "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName"     "${PRODUCT}"
VIAddVersionKey /LANG=1033 "CompanyName"     "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright"  "Created by ${PUBLISHER}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=1033 "FileVersion"     "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion"  "${VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "x64.nsh"

; ---------------------------------------------------------------------------------------
; Look

!define MUI_ICON   "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP   "${WELCOME_BMP}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${WELCOME_BMP}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP   "${HEADER_BMP}"
!define MUI_HEADERIMAGE_UNBITMAP "${HEADER_BMP}"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

; remember the chosen language for upgrades and the uninstaller
!define MUI_LANGDLL_REGISTRY_ROOT      HKCU
!define MUI_LANGDLL_REGISTRY_KEY       "${SETUP_KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Language"

; ---------------------------------------------------------------------------------------
; Pages

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "$(RunApp)"
!ifdef SERVER_DIR
  ; second finish-page checkbox (MUI's "show readme" slot): run the server installer
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "$(RunServerSetup)"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION RunServerInstall
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!endif
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Hebrew"
!insertmacro MUI_RESERVEFILE_LANGDLL

; ---------------------------------------------------------------------------------------
; Texts

LangString SecAppGroup    ${LANG_ENGLISH} "WitBox app"
LangString SecAppGroup    ${LANG_HEBREW}  "אפליקציית WitBox"
LangString SecCore        ${LANG_ENGLISH} "WitBox (required)"
LangString SecCore        ${LANG_HEBREW}  "WitBox (חובה)"
LangString SecDesktop     ${LANG_ENGLISH} "Desktop shortcut"
LangString SecDesktop     ${LANG_HEBREW}  "קיצור דרך בשולחן העבודה"
LangString SecAutostart   ${LANG_ENGLISH} "Start with Windows"
LangString SecAutostart   ${LANG_HEBREW}  "הפעלה עם עליית Windows"
LangString SecServer      ${LANG_ENGLISH} "WitBox server on this PC (WSL2, experimental)"
LangString SecServer      ${LANG_HEBREW}  "שרת WitBox במחשב הזה (WSL2, ניסיוני)"

LangString DescCore       ${LANG_ENGLISH} "The WitBox desktop app, a Start menu shortcut and the uninstaller. It connects to your own WitBox server over your Tailscale network."
LangString DescCore       ${LANG_HEBREW}  "אפליקציית שולחן העבודה של WitBox, קיצור דרך בתפריט התחל ומסיר ההתקנה. מתחברת לשרת ה-WitBox הפרטי שלך דרך רשת ה-Tailscale שלך."
LangString DescDesktop    ${LANG_ENGLISH} "Adds a WitBox shortcut to the desktop."
LangString DescDesktop    ${LANG_HEBREW}  "מוסיף קיצור דרך של WitBox לשולחן העבודה."
LangString DescAutostart  ${LANG_ENGLISH} "Starts WitBox minimized to the tray when you sign in, so bot notifications arrive in the background."
LangString DescAutostart  ${LANG_HEBREW}  "מפעיל את WitBox ממוזער במגש המערכת בעת הכניסה ל-Windows, כך שהתראות מהבוטים יגיעו ברקע."
LangString DescServer     ${LANG_ENGLISH} "Experimental: copies the files needed to run the WitBox server itself on this PC inside WSL2, and adds an $\"Install WitBox server$\" shortcut that sets it up."
LangString DescServer     ${LANG_HEBREW}  "ניסיוני: מעתיק את הקבצים הדרושים להרצת שרת WitBox עצמו במחשב הזה בתוך WSL2, ומוסיף קיצור דרך $\"Install WitBox server$\" שמתקין אותו."

LangString RunApp         ${LANG_ENGLISH} "Start WitBox"
LangString RunApp         ${LANG_HEBREW}  "הפעל את WitBox"
LangString RunServerSetup ${LANG_ENGLISH} "Install the WitBox server on this PC now (WSL2)"
LangString RunServerSetup ${LANG_HEBREW}  "התקן עכשיו את שרת WitBox במחשב הזה (WSL2)"
LangString LnkServer      ${LANG_ENGLISH} "Install WitBox server"
LangString LnkServer      ${LANG_HEBREW}  "Install WitBox server"
LangString LnkUninstall   ${LANG_ENGLISH} "Uninstall WitBox"
LangString LnkUninstall   ${LANG_HEBREW}  "הסרת WitBox"

; ---------------------------------------------------------------------------------------
; Helpers

; A running copy keeps WitBox.exe locked; it lives in the tray, so close it first.
!macro CloseRunningApp
  IfFileExists "$INSTDIR\${EXE_NAME}" 0 +3
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${EXE_NAME}"'
    Pop $0
  Sleep 400
!macroend

; ---------------------------------------------------------------------------------------
; Components

SectionGroup /e "$(SecAppGroup)" GrpApp

  Section "$(SecCore)" SecCoreId
    SectionIn RO
    SetShellVarContext current
    !insertmacro CloseRunningApp
    SetOutPath "$INSTDIR"
    SetOverwrite on
    File "/oname=${EXE_NAME}" "${APP_EXE}"
    WriteUninstaller "$INSTDIR\uninstall.exe"

    CreateDirectory "$SMPROGRAMS\WitBox"
    CreateShortcut "$SMPROGRAMS\WitBox\WitBox.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
    CreateShortcut "$SMPROGRAMS\WitBox\$(LnkUninstall).lnk" "$INSTDIR\uninstall.exe"

    WriteRegStr HKCU "${SETUP_KEY}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${SETUP_KEY}" "UninstallLink" "$(LnkUninstall)"

    ; Settings > Apps / "Add or remove programs" (per-user entry)
    WriteRegStr   HKCU "${ARP_KEY}" "DisplayName"          "${PRODUCT}"
    WriteRegStr   HKCU "${ARP_KEY}" "DisplayVersion"       "${VERSION}"
    WriteRegStr   HKCU "${ARP_KEY}" "Publisher"            "${PUBLISHER}"
    WriteRegStr   HKCU "${ARP_KEY}" "DisplayIcon"          "$INSTDIR\${EXE_NAME},0"
    WriteRegStr   HKCU "${ARP_KEY}" "InstallLocation"      "$INSTDIR"
    WriteRegStr   HKCU "${ARP_KEY}" "UninstallString"      '"$INSTDIR\uninstall.exe"'
    WriteRegStr   HKCU "${ARP_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "${ARP_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${ARP_KEY}" "NoRepair" 1
    SectionGetSize ${SecCoreId} $0
    WriteRegDWORD HKCU "${ARP_KEY}" "EstimatedSize" $0
  SectionEnd

  Section "$(SecDesktop)" SecDesktopId
    SetShellVarContext current
    CreateShortcut "$DESKTOP\WitBox.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  SectionEnd

  Section /o "$(SecAutostart)" SecAutostartId
    WriteRegStr HKCU "${RUN_KEY}" "WitBox" '"$INSTDIR\${EXE_NAME}" --hidden'
  SectionEnd

SectionGroupEnd

!ifdef SERVER_DIR
Section /o "$(SecServer)" SecServerId
  SetShellVarContext current
  SetOutPath "$INSTDIR\server"
  SetOverwrite on
  File "${SERVER_DIR}/install-server.ps1"
  File "${SERVER_DIR}/install.sh"
  File "${SERVER_DIR}/witbox-linux-x86_64.tar.gz"
  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\WitBox"
  ; $WINDIR\System32 as literal text: Explorer (64-bit) starts the 64-bit PowerShell, which
  ; is the one that can see wsl.exe
  CreateShortcut "$SMPROGRAMS\WitBox\$(LnkServer).lnk" \
      "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" \
      '-ExecutionPolicy Bypass -File "$INSTDIR\server\install-server.ps1"' \
      "$INSTDIR\${EXE_NAME}" 0
SectionEnd
!endif

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${GrpApp}          "$(DescCore)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCoreId}       "$(DescCore)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktopId}    "$(DescDesktop)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutostartId}  "$(DescAutostart)"
  !ifdef SERVER_DIR
    !insertmacro MUI_DESCRIPTION_TEXT ${SecServerId}   "$(DescServer)"
  !endif
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------------------------------
; Callbacks

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY   ; skipped in silent mode (system language is used)
  ; an upgrade keeps "start with Windows" if it was on
  ReadRegStr $0 HKCU "${RUN_KEY}" "WitBox"
  ${If} $0 != ""
    !insertmacro SelectSection ${SecAutostartId}
  ${EndIf}
FunctionEnd

!ifdef SERVER_DIR
Function FinishShow
  ; offer "install the server now" only when that component was installed
  ${IfNot} ${SectionIsSelected} ${SecServerId}
    ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function RunServerInstall
  ${IfNot} ${FileExists} "$INSTDIR\server\install-server.ps1"
    Return
  ${EndIf}
  ; a 32-bit installer would otherwise start the 32-bit PowerShell (no wsl.exe there)
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -File "$INSTDIR\server\install-server.ps1"'
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
FunctionEnd
!endif

; ---------------------------------------------------------------------------------------
; Uninstaller (removes the program; settings in %APPDATA%\WitBox are kept)

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro CloseRunningApp

  Delete "$INSTDIR\${EXE_NAME}"
  Delete "$INSTDIR\server\install-server.ps1"
  Delete "$INSTDIR\server\install.sh"
  Delete "$INSTDIR\server\witbox-linux-x86_64.tar.gz"
  RMDir  "$INSTDIR\server"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"

  ReadRegStr $0 HKCU "${SETUP_KEY}" "UninstallLink"
  ${If} $0 != ""
    Delete "$SMPROGRAMS\WitBox\$0.lnk"
  ${EndIf}
  Delete "$SMPROGRAMS\WitBox\$(LnkUninstall).lnk"
  Delete "$SMPROGRAMS\WitBox\WitBox.lnk"
  Delete "$SMPROGRAMS\WitBox\Install WitBox server.lnk"
  RMDir  "$SMPROGRAMS\WitBox"
  Delete "$DESKTOP\WitBox.lnk"

  DeleteRegValue HKCU "${RUN_KEY}" "WitBox"
  DeleteRegKey   HKCU "${ARP_KEY}"
  DeleteRegKey   HKCU "${SETUP_KEY}"
  DeleteRegKey /ifempty HKCU "Software\WitBox"
SectionEnd
