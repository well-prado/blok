@echo off
setlocal
set VERSION=8.10.2
set ROOT_DIR=%~dp0
if not defined GRADLE_USER_HOME set GRADLE_USER_HOME=%USERPROFILE%\.gradle
set DIST_DIR=%GRADLE_USER_HOME%\wrapper\dists\gradle-%VERSION%-bin\gradle-%VERSION%
if not exist "%DIST_DIR%\bin\gradle.bat" (
  echo Downloading Gradle %VERSION%...
  set ARCHIVE=%GRADLE_USER_HOME%\wrapper\dists\gradle-%VERSION%-bin.zip
  if not exist "%ARCHIVE%" powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing https://services.gradle.org/distributions/gradle-%VERSION%-bin.zip -OutFile '%ARCHIVE%'"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Force '%ARCHIVE%' '%GRADLE_USER_HOME%\wrapper\dists\gradle-%VERSION%-bin'"
)
call "%DIST_DIR%\bin\gradle.bat" --project-dir "%ROOT_DIR%" %*
