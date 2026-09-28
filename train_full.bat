@echo off
REM ═══════════════════════════════════════════════════════════════
REM  ILARIA — Full Progressive Training Pipeline (CUDA)
REM  GTX 1660 Ti | CUDA 13.2 | SM 7.5
REM ═══════════════════════════════════════════════════════════════

set DATA_DIR=./data/cortex-smart
set TRAIN=ilaria-train-gpu.exe

echo.
echo ================================================================
echo   PHASE 1: Foundation (general.jsonl) - 20 epochs
echo ================================================================
%TRAIN% --fresh --data-dir %DATA_DIR% --corpus ./data/corpus/general.jsonl --epochs 20 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   PHASE 2: Reasoning (reasoning.jsonl) - 15 epochs
echo ================================================================
%TRAIN% --data-dir %DATA_DIR% --corpus ./data/corpus/reasoning.jsonl --epochs 15 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   PHASE 3: Mathematics (gsm8k_converted.jsonl) - 10 epochs
echo ================================================================
%TRAIN% --data-dir %DATA_DIR% --corpus ./data/corpus/gsm8k_converted.jsonl --epochs 10 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   PHASE 4: Instructions (dolly.jsonl) - 10 epochs
echo ================================================================
%TRAIN% --data-dir %DATA_DIR% --corpus ./data/corpus/dolly.jsonl --epochs 10 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   PHASE 5: Stanford Alpaca (alpaca.jsonl) - 8 epochs
echo ================================================================
%TRAIN% --data-dir %DATA_DIR% --corpus ./data/corpus/alpaca.jsonl --epochs 8 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   PHASE 6: Romanian Knowledge (wikipedia_ro.jsonl) - 5 epochs
echo ================================================================
%TRAIN% --data-dir %DATA_DIR% --corpus ./data/corpus/wikipedia_ro.jsonl --epochs 5 --curriculum --revisit --seed 42
if %ERRORLEVEL% NEQ 0 goto :error

echo.
echo ================================================================
echo   ALL PHASES COMPLETE! Organism saved to %DATA_DIR%
echo ================================================================
goto :end

:error
echo.
echo *** TRAINING FAILED at phase above ***
exit /b 1

:end
echo Done!
