@echo off
chcp 65001 >nul
title LMS Automation - Auto Installer
color 0A

echo.
echo  ==========================================
echo   LMS VIDEO AUTOMATION - AUTO INSTALLER
echo  ==========================================
echo.

:: ─── STEP 1: Check winget ────────────────────────────────────────────────────
echo [1/7] Checking winget...
winget --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: winget nahi mila. Windows update karo.
    pause
    exit /b 1
)
echo  winget OK

:: ─── STEP 2: Install Node.js ─────────────────────────────────────────────────
echo.
echo [2/7] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js nahi hai. Install ho raha hai...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    echo.
    echo  ✅ Node.js install hua!
    echo  ⚠️  Yeh window BAND karo aur install.bat DOBARA chalao!
    pause
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('node --version') do echo  Node.js %%i ✅
)

:: ─── STEP 3: Install Git ─────────────────────────────────────────────────────
echo.
echo [3/7] Checking Git...
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Git nahi hai. Install ho raha hai...
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    echo.
    echo  ✅ Git install hua!
    echo  ⚠️  Yeh window BAND karo aur install.bat DOBARA chalao!
    pause
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('git --version') do echo  %%i ✅
)

:: ─── STEP 4: Clone Repo ──────────────────────────────────────────────────────
echo.
echo [4/7] Project download ho raha hai GitHub se...

if exist "lms-automation" (
    echo  Folder already hai. Skip.
    cd lms-automation
) else (
    git clone https://github.com/iamsachinaryan/lms-automation.git
    if %errorlevel% neq 0 (
        echo  ERROR: Download fail hua! Internet check karo.
        pause
        exit /b 1
    )
    cd lms-automation
    echo  Project download hua ✅
)

:: ─── STEP 5: Create .env ─────────────────────────────────────────────────────
echo.
echo [5/7] Account setup...

if exist ".env" (
    echo  .env already hai. Skip.
) else (
    echo.
    echo  ╔══════════════════════════════════════╗
    echo  ║   lms.aimdip.org ka login daalo      ║
    echo  ╚══════════════════════════════════════╝
    echo.
    set /p LMS_EMAIL="  Email daalo: "
    set /p LMS_PASSWORD="  Password daalo: "
    echo.

    (
        echo LMS_EMAIL=%LMS_EMAIL%
        echo LMS_PASSWORD=%LMS_PASSWORD%
        echo LMS_URL=https://lms.aimdip.org
        echo HEADLESS=true
        echo VIEWPORT_WIDTH=1280
        echo VIEWPORT_HEIGHT=800
        echo SLOW_MO=0
        echo MAX_CONCURRENCY=2
        echo MAX_RETRIES=3
        echo RETRY_BASE_DELAY_MS=5000
        echo NAV_TIMEOUT=60000
        echo PLAYER_INIT_TIMEOUT=30000
        echo WATCH_PERCENTAGE=92
        echo SESSION_DIR=./sessions
        echo SCREENSHOT_DIR=./screenshots
        echo LOG_LEVEL=info
        echo LOG_DIR=./logs
        echo HEALTH_PORT=3001
        echo SLACK_WEBHOOK_URL=
        echo TELEGRAM_BOT_TOKEN=
        echo TELEGRAM_CHAT_ID=
        echo NOTIFICATION_EMAIL=
        echo GENERIC_WEBHOOK_URL=
        echo REPORT_CRON=59 23 * * *
    ) > .env

    echo  Account save hua ✅
)

:: ─── STEP 6: Create Folders ──────────────────────────────────────────────────
echo.
echo [6/7] Folders bana raha hai...
if not exist "sessions"     mkdir sessions
if not exist "screenshots"  mkdir screenshots
if not exist "logs"         mkdir logs
echo  Folders ready ✅

:: ─── STEP 7: npm install ─────────────────────────────────────────────────────
echo.
echo [7/7] Dependencies install ho rahi hain...
echo  (2-5 minute lag sakte hain, ruko)
echo.
call npm install
if %errorlevel% neq 0 (
    echo  ERROR: npm install fail hua!
    pause
    exit /b 1
)

:: ─── ALL DONE ─────────────────────────────────────────────────────────────────
echo.
echo  ==========================================
echo   SETUP COMPLETE! ✅
echo  ==========================================
echo.
echo  Ab kya karna hai:
echo.
echo   STEP 1 - Pehli baar setup (browser khulega):
echo            node setup.js
echo.
echo   STEP 2 - Server start karo:
echo            node server.js
echo.
echo   STEP 3 - Browser mein kholo:
echo            http://localhost:3000
echo  ==========================================
echo.
set /p RUN_SETUP="  Abhi setup chalayein? (y/n): "
if /i "%RUN_SETUP%"=="y" (
    echo.
    echo  Browser khul raha hai - login karo aur video play karo...
    node setup.js
    echo.
    echo  Server start ho raha hai...
    node server.js
)

pause
