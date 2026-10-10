@echo off
REM Double-click wrapper for tools\build-apk-menu.mjs (choose Debug or Release).
REM Deliberately minimal and pure ASCII: the real logic lives in the .mjs file,
REM because .bat cannot be automated-tested and cmd mis-reads non-ASCII content.
REM The menu shown to the user is printed by the .mjs, so Chinese text stays intact.
cd /d "%~dp0"
node tools\build-apk-menu.mjs %*
pause
