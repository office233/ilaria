@echo off
REM Build script for CUDA ilaria DLL using MSVC toolchain.
REM
REM Portabilitate: detectează automat CUDA și Visual Studio.
REM   - CUDA: caută %CUDA_PATH% (setat de installer), apoi versiunile
REM           cunoscute. Operatorul poate forța prin set CUDA_PATH=...
REM   - MSVC: caută vswhere.exe (livrat cu VS Installer), apoi versiunile
REM           cunoscute. Acceptă BuildTools, Community, Professional.
REM
REM Produces three artefacts in this directory:
REM   cuda_ilaria.dll  — runtime library (BitNet sparse + cuBLAS dense matmul)
REM   cuda_ilaria.lib  — MSVC import library
REM   libcuda_ilaria.a — MinGW/GCC import library for CGO

setlocal enabledelayedexpansion

REM ─── Detect CUDA ────────────────────────────────────────────────────
REM Order: env var (set by installer or operator) > known-version folders.
if defined CUDA_PATH (
    set "CUDA_PATH_LOCAL=%CUDA_PATH%"
    echo [build] Using CUDA from CUDA_PATH: !CUDA_PATH_LOCAL!
) else (
    for %%v in (v13.2 v13.1 v13.0 v12.6 v12.5 v12.4 v12.3 v12.2 v12.1 v12.0) do (
        if exist "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\%%v\bin\nvcc.exe" (
            set "CUDA_PATH_LOCAL=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\%%v"
            echo [build] Auto-detected CUDA: !CUDA_PATH_LOCAL!
            goto :cuda_found
        )
    )
    echo [build] ERROR: CUDA toolkit not found. Set CUDA_PATH or install CUDA Toolkit ^>= 12.0
    exit /b 2
)
:cuda_found

if not exist "%CUDA_PATH_LOCAL%\bin\nvcc.exe" (
    echo [build] ERROR: nvcc.exe not found in %CUDA_PATH_LOCAL%\bin
    exit /b 2
)

REM ─── Detect MSVC via vswhere ───────────────────────────────────────
REM vswhere.exe trăiește în %ProgramFiles(x86)%\Microsoft Visual Studio\Installer
REM Returnează cea mai nouă instalare cu workload-ul VC.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [build] vswhere not found, falling back to known paths
    goto :fallback_vs
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VS_INSTALL=%%i"
)
if defined VS_INSTALL (
    set "VCVARS=!VS_INSTALL!\VC\Auxiliary\Build\vcvarsall.bat"
    if exist "!VCVARS!" (
        echo [build] Using VS from vswhere: !VS_INSTALL!
        goto :vs_found
    )
)

:fallback_vs
REM Fallback: încercăm path-urile clasice ale VS 2022.
for %%e in (BuildTools Community Professional Enterprise) do (
    if exist "C:\Program Files\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvarsall.bat" (
        set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvarsall.bat"
        echo [build] Auto-detected VS 2022 %%e (64-bit install)
        goto :vs_found
    )
    if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvarsall.bat" (
        set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\%%e\VC\Auxiliary\Build\vcvarsall.bat"
        echo [build] Auto-detected VS 2022 %%e (32-bit install)
        goto :vs_found
    )
    if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\%%e\VC\Auxiliary\Build\vcvarsall.bat" (
        set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\%%e\VC\Auxiliary\Build\vcvarsall.bat"
        echo [build] Auto-detected VS 2019 %%e
        goto :vs_found
    )
)
echo [build] ERROR: Visual Studio not found. Install VS 2019/2022 with "Desktop development with C++"
exit /b 3

:vs_found
call "%VCVARS%" x64 >nul
if errorlevel 1 (
    echo [build] ERROR: vcvarsall.bat failed
    exit /b 3
)

REM ─── Compile CUDA source files ─────────────────────────────────────
REM -arch=sm_75 covers Turing (GTX 1660 Ti), Volta, and newer.
REM -DCUDA_ILARIA_EXPORTS triggers __declspec(dllexport).
REM -Xcompiler "/EHsc" makes MSVC happy about C++ exception handling.
nvcc -c -o forward_sparse.obj   forward_sparse.cu   -arch=sm_75 -DCUDA_ILARIA_EXPORTS -Xcompiler "/EHsc"
if errorlevel 1 goto :error
nvcc -c -o cublas_matmul.obj    cublas_matmul.cu    -arch=sm_75 -DCUDA_ILARIA_EXPORTS -Xcompiler "/EHsc"
if errorlevel 1 goto :error

REM ─── Link DLL ──────────────────────────────────────────────────────
REM cudart.lib + cublas.lib resolve runtime/library symbols.
link /DLL /OUT:cuda_ilaria.dll forward_sparse.obj cublas_matmul.obj ^
    cudart.lib cublas.lib ^
    /LIBPATH:"%CUDA_PATH_LOCAL%\lib\x64" /NOLOGO
if errorlevel 1 goto :error

REM ─── Regenerate MinGW import library for cgo ──────────────────────
dumpbin /EXPORTS cuda_ilaria.dll > exports.txt

echo LIBRARY cuda_ilaria > cuda_ilaria.def
echo EXPORTS >> cuda_ilaria.def
for /f "tokens=4" %%a in ('findstr /r "ilaria_cuda_ ilaria_cublas_" exports.txt') do (
    echo     %%a >> cuda_ilaria.def
)

dlltool -d cuda_ilaria.def -l libcuda_ilaria.a
if errorlevel 1 goto :error

echo.
echo === Build successful ===
echo   cuda_ilaria.dll  - runtime library
echo   cuda_ilaria.lib  - MSVC import library
echo   libcuda_ilaria.a - MinGW import library for CGO
goto :eof

:error
echo.
echo === BUILD FAILED ===
exit /b 1
