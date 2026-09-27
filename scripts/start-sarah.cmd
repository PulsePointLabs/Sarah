@echo off
setlocal
rem A browser/PWA shortcut alone cannot start the local backend.
set "ELECTRON_RUN_AS_NODE="
set "SARAH_INSTALL=%~dp0..\desktop-release\win-unpacked"
if not exist "%SARAH_INSTALL%\Sarah.exe" (
  echo Sarah.exe was not found in "%SARAH_INSTALL%".
  echo Restore the Windows installation before trying again.
  exit /b 1
)
"%SARAH_INSTALL%\resources\node-runtime\node.exe" "%~dp0wait-sarah-ready.cjs" --check >nul 2>&1
if errorlevel 1 (
  start "" /D "%SARAH_INSTALL%" "%SARAH_INSTALL%\Sarah.exe"
  "%SARAH_INSTALL%\resources\node-runtime\node.exe" "%~dp0wait-sarah-ready.cjs"
  if errorlevel 1 (
    echo Sarah did not become ready. Check the Sarah backend logs before retrying.
    pause
    exit /b 1
  )
)
rem The backend may belong to Windows session 0. Open the UI in this user's session.
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:8787
) else (
  start "" "http://127.0.0.1:8787"
)
exit /b %errorlevel%
