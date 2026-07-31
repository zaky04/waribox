@echo off
set PATH=C:\Program Files\nodejs;C:\Users\djaka\AppData\Roaming\npm;%PATH%
cd /d "%~dp0"
call pnpm --filter @gestion-boutique/web run dev
