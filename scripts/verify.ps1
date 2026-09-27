$ErrorActionPreference = 'Stop'
throw 'Native OS validation runs on Linux: go test -race ./...; go vet ./...; scripts/build-os.sh; scripts/smoke-os.py. See docs/NATIVE_OS.md.'
