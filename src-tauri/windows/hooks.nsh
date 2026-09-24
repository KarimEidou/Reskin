; Reskin NSIS installer hooks (see tauri's installer.nsi for the variables).

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Remove the Explorer verb "Reskin this icon" (created in HKCU when the
    ; user enables it in Settings; the app re-creates it after an update).
    DeleteRegKey HKCU "Software\Classes\lnkfile\shell\Reskin"
    DeleteRegKey HKCU "Software\Classes\InternetShortcut\shell\Reskin"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Reskin"
  ${EndIf}
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; The user asked to delete Reskin's data, which includes the .ico files
    ; that customised icons point at. Put every original icon back first.
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore-all --quiet'
  ${EndIf}
!macroend
