@echo off
REM Double-click wrapper for setup-android.mjs.
REM Deliberately minimal and pure ASCII: the real logic lives in the .mjs file,
REM because .bat cannot be automated-tested and cmd mis-reads non-ASCII content.
cd /d "%~dp0"
node setup-android.mjs %*
pause
