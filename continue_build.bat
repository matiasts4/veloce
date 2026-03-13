powershell -c "New-Item -ItemType Directory -Force -Path src-tauri\resources\whispercpp"
powershell -c "Copy-Item 'C:\wsp\build\bin\Release\*.exe' -Destination src-tauri\resources\whispercpp -Force"
powershell -c "Copy-Item 'C:\wsp\build\bin\Release\*.dll' -Destination src-tauri\resources\whispercpp -Force"
powershell -c "Copy-Item 'C:\wsp\models\*.bin' -Destination src-tauri\resources\whispercpp -Force"
xcopy "src-tauri\resources\whispercpp" "dist\audio-engine\whispercpp\" /E /I /Y
python zip_audio_engine.py
call bun run tauri build
