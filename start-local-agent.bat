@echo off
REM Local Agent v2 — Cloud-connected file watcher
REM Reads Supabase credentials from backend/.env

cd /d "%~dp0backend"

set "SUPABASE_URL="
set "SUPABASE_SERVICE_ROLE_KEY="
set "WORKSPACE_ID="

for /f "tokens=1,2 delims==" %%a in ('type .env ^| findstr /r "^NEXT_PUBLIC_SUPABASE_URL=^SUPABASE_SERVICE_ROLE_KEY=^DEFAULT_WORKSPACE_ID="') do (
  if "%%a"=="NEXT_PUBLIC_SUPABASE_URL" set "SUPABASE_URL=%%b"
  if "%%a"=="SUPABASE_SERVICE_ROLE_KEY" set "SUPABASE_SERVICE_ROLE_KEY=%%b"
  if "%%a"=="DEFAULT_WORKSPACE_ID" set "WORKSPACE_ID=%%b"
)

echo ========================================
echo  Local Agent v2 — Cloud File Watcher
echo ========================================
echo Supabase: %SUPABASE_URL%
echo Workspace: %WORKSPACE_ID%
echo.

node localAgentV2.js
