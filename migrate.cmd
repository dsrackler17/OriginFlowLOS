@echo off
REM ============================================================================
REM OriginFlow migration runner — Windows wrapper
REM ----------------------------------------------------------------------------
REM Usage:
REM   migrate status      Show applied vs pending
REM   migrate up          Apply all pending migrations
REM   migrate mark-all    Backfill (mark all current files as applied)
REM   migrate validate    Check filenames + detect drift
REM
REM Prerequisites:
REM   1. Deno installed:    iwr https://deno.land/install.ps1 -useb ^| iex
REM   2. DATABASE_URL set:  see the top comment in migrate.ts
REM ============================================================================

where deno >nul 2>nul
if errorlevel 1 (
  echo.
  echo Deno is not installed or not on PATH.
  echo.
  echo Install it in PowerShell:
  echo   iwr https://deno.land/install.ps1 -useb ^| iex
  echo.
  echo Then restart your terminal and try again.
  echo.
  exit /b 1
)

deno run --allow-net --allow-read --allow-env migrate.ts %*
