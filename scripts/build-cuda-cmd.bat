@echo off
REM build-cuda-cmd.bat — build a cmd/* binary with CUDA support and
REM co-locate cuda_nexus.dll next to it.
REM
REM This closes the trap documented in HARDCODING_AND_LIMITATIONS.md §10:
REM binaries built with -tags cuda depend on cuda_nexus.dll, which
REM Windows only finds next to the executable (or on PATH). Forgetting
REM the copy produces a silent exit 0xC0000135 with no error message.
REM
REM Usage:
REM   scripts\build-cuda-cmd.bat nxtf-run          → bin\nxtf-run.exe
REM   scripts\build-cuda-cmd.bat cortex-broca-train
REM
REM Builds the DLL first if it is missing (requires CUDA toolkit + VS).

setlocal
set "ROOT=%~dp0.."
set "CUDA_DIR=%ROOT%\cortex\compute\cuda"
set "BIN_DIR=%ROOT%\bin"

if "%~1"=="" (
    echo usage: %~nx0 ^<cmd-name^>   e.g. %~nx0 nxtf-run
    exit /b 1
)
set "CMD_NAME=%~1"

if not exist "%ROOT%\cmd\%CMD_NAME%\main.go" (
    echo [build-cuda] ERROR: cmd\%CMD_NAME% does not exist
    exit /b 1
)

REM ─── Ensure the DLL exists (build it on first use) ─────────────────
if not exist "%CUDA_DIR%\cuda_nexus.dll" (
    echo [build-cuda] cuda_nexus.dll missing — building it first...
    pushd "%CUDA_DIR%"
    call build.bat
    if errorlevel 1 (
        popd
        echo [build-cuda] ERROR: DLL build failed
        exit /b 2
    )
    popd
)

REM ─── Build the Go binary with the cuda tag ─────────────────────────
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
pushd "%ROOT%"
go build -tags cuda -o "%BIN_DIR%\%CMD_NAME%.exe" ".\cmd\%CMD_NAME%"
if errorlevel 1 (
    popd
    echo [build-cuda] ERROR: go build failed
    exit /b 3
)
popd

REM ─── Co-locate the DLL (the whole point of this script) ────────────
copy /Y "%CUDA_DIR%\cuda_nexus.dll" "%BIN_DIR%\" >nul
if errorlevel 1 (
    echo [build-cuda] ERROR: failed to copy cuda_nexus.dll
    exit /b 4
)

echo [build-cuda] OK: %BIN_DIR%\%CMD_NAME%.exe (+ cuda_nexus.dll)
endlocal
