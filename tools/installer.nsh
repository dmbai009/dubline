; Per-user handler, owned by Setup. Protected Windows UserChoice is read only.
!define DUBLINE_SETUP_PROGID "io.github.dmbai009.Dubline.Setup.Project"
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend
; Assisted installers otherwise offer all-users mode to an elevated process.
; Dubline's workspace, updater and associations consistently belong to this user.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
!macro customInstall
  WriteRegStr HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}" "" "Dubline Project"
  WriteRegStr HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}" "DublineOwner" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.dubline\OpenWithProgids" "${DUBLINE_SETUP_PROGID}" ""
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.dubline\UserChoice" "ProgId"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Classes\.dubline" ""
    ${If} $0 == ""
      ReadRegStr $0 HKCR ".dubline" ""
      ${If} $0 == ""
        WriteRegStr HKCU "Software\Classes\.dubline" "" "${DUBLINE_SETUP_PROGID}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}" "DublineOwner"
  ${If} $0 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DeleteRegKey HKCU "Software\Classes\${DUBLINE_SETUP_PROGID}"
    DeleteRegValue HKCU "Software\Classes\.dubline\OpenWithProgids" "${DUBLINE_SETUP_PROGID}"
    ReadRegStr $0 HKCU "Software\Classes\.dubline" ""
    ${If} $0 == "${DUBLINE_SETUP_PROGID}"
      DeleteRegValue HKCU "Software\Classes\.dubline" ""
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
