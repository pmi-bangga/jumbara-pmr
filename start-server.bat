@echo off
cd /d "%~dp0"
echo Menjalankan Server Jumbara PMR di http://127.0.0.1:8000 ...
echo Layar TV Publik: http://127.0.0.1:8000/publik.html
echo Dashboard:       http://127.0.0.1:8000/index.html
start "" "http://127.0.0.1:8000/index.html"
C:\xampp\php\php.exe -S 127.0.0.1:8000
