@echo off
title G2G StockNexus Server
echo ========================================================
echo   Starting G2G StockNexus Multi-Seller Management Server
echo ========================================================
echo.
cd /d "%~dp0"
start http://localhost:3000
npm start
pause
