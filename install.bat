@echo off
chcp 65001 >nul
title LMS Automation - Auto Installer
color 0A

echo.
echo  ==========================================
echo   LMS VIDEO AUTOMATION - AUTO INSTALLER
echo  ==========================================
echo.

:: STEP 1: Check winget
echo [1/7] Checking package manager (winget)...
winget --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: winget not found. Please update Windows.
    pause
    exit /b 1
)
echo  winget OK

:: STEP 2: Install Node.js if missing
echo.
echo [2/7] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js not found. Installing...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    echo  Node.js installed! Please CLOSE and run install.bat again.
    pause
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('node --version') do echo  Node.js %%i OK
)

:: STEP 3: Install Git if missing
echo.
echo [3/7] Checking Git...
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Git not found. Installing...
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    echo  Git installed! Please CLOSE and run install.bat again.
    pause
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('git --version') do echo  %%i OK
)

:: STEP 4: Clone the repository
echo.
echo [4/7] Cloning project from GitHub...

if exist "lms-automation" (
    echo  Folder already exists. Skipping clone.
    cd lms-automation
) else (
    echo.
    echo  GitHub Token chahiye (private repo ke liye)
    echo  Token banao: https://github.com/settings/tokens/new
    echo    - Expiration: 90 days
    echo    - Sirf "repo" checkbox tick karo
    echo    - Generate karke copy karo
    echo.
    set /p GH_TOKEN="  GitHub Token paste karo: "
    echo.
    git clone https://%GH_TOKEN%@github.com/iamsachinaryan/lms-automation.git
    if %errorlevel% neq 0 (
        echo  ERROR: Clone fail! Token galat ya internet nahi.
        pause
        exit /b 1
    )
    cd lms-automation
)

:: STEP 5: Create .env file
echo.
echo [5/7] Setting up .env configuration...

if exist ".env" (
    echo  .env already exists. Skipping.
) else (
    echo.
    echo  LMS credentials daalo:
    set /p LMS_EMAIL="  Email: "
    set /p LMS_PASSWORD="  Password: "
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
    echo  .env file created OK
)

:: STEP 6: Create required folders
echo.
echo [6/7] Creating required folders...
if not exist "sessions"     mkdir sessions
if not exist "screenshots"  mkdir screenshots
if not exist "logs"         mkdir logs
echo  Folders OK

:: STEP 7: npm install
echo.
echo [7/7] Installing dependencies (2-5 min lagenge, wait karo)...
call npm install
if %errorlevel% neq 0 (
    echo  ERROR: npm install fail hua!
    pause
    exit /b 1
)

echo.
echo  ==========================================
echo   SETUP COMPLETE!
echo  ==========================================
echo.
echo   Abhi run karo:
echo     node setup.js   (pehli baar - browser mein login karo)
echo     node server.js  (server start)
echo     http://localhost:3000 (browser mein kholo)
echo  ==========================================
echo.
set /p RUN_SETUP="  Abhi node setup.js chalayein? (y/n): "
if /i "%RUN_SETUP%"=="y" (
    node setup.js
    echo.
    echo  Ab server start kar rahe hain...
    node server.js
)

pause
