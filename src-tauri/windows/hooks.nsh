; Reskin NSIS installer hooks (see tauri's installer.nsi for the variables).

!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  ${If} $UpdateMode <> 1
    ; Remove the Explorer verb "Reskin this icon" (created in HKCU when the
    ; user enables it in Settings; the app re-creates it after an update).
    DeleteRegKey HKCU "Software\Classes\lnkfile\shell\Reskin"
    DeleteRegKey HKCU "Software\Classes\InternetShortcut\shell\Reskin"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Reskin"
    ; "Start with Windows": the Run value and Task Manager's on/off flag for
    ; it (reskin-core settings::autostart::ENTRY_NAME).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Reskin"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Reskin"
    ; A silent or passive uninstall shows no "Delete app data" check box;
    ; /DELETEAPPDATA ticks it.
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      ClearErrors
      ${GetOptions} $CMDLINE "/DELETEAPPDATA" $R0
      ${IfNot} ${Errors}
        StrCpy $DeleteAppDataCheckboxState 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; The user asked to delete Reskin's data, which includes the .ico files
    ; that customised icons point at. Put every original icon back first
    ; (Public-Desktop items ask for administrator approval once). If that
    ; fails, keep the data: the icons keep working and can still be restored.
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-all --quiet' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "Reskin could not put back every icon it changed, so its data (settings, history and icons) stays on this PC for now.$\r$\n$\r$\nTo remove it, install Reskin again, use Restore all icons, and uninstall it." /SD IDOK
      StrCpy $DeleteAppDataCheckboxState 0
    ${EndIf}
  ${EndIf}
  Pop $R0
!macroend
