@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
    echo 首次运行，正在安装依赖，请稍候...
    npm install
    echo.
)
node_modules\.bin\electron .
