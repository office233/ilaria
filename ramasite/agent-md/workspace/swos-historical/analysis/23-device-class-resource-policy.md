# SwypikOS — device-class resource policy handoff — 2026-09-30

Workspace: E:\nexus\swypik-os
Branch/HEAD: agent/nexus-clean-swyp-fast / a5a8175
Repo intentionally dirty; no reset/clean/stash/commit/push performed.

## Completed
- Hardware Manifest device_class: unknown/workstation/mobile/automotive/robot/appliance/embedded.
- Device Graph buses extended for CAN/UART/I2C/SPI/GPIO/MODBUS/Ethernet/BLE.
- resource.ForDeviceClass only tightens the selected phone/balanced/performance envelope.
- Caps: mobile 3% CPU/8% GPU/1 worker; automotive 2%/5%/1; robot 3%/8%/1; appliance/embedded 2%/5%/1; workstation adds no cap.
- Automotive is infotainment/compute-only and grants no actuator authority.
- SelectionFromManifest added; explicit SWYPIK_RESOURCE_PROFILE remains the maximum base envelope.
- Control Kernel ResourcePolicy/ResourceState now persist device_class; generated manifest/DTO regenerated.
- Legacy resource journal entries without device_class remain replayable.
- Added installer/universal/hardware_manifest.go HAL -> canonical manifest adapter.
- Installer TargetEnvironment carries HardwareManifest and AdaptationPlan carries manifest-derived ResourcePolicy.
- Adapter excludes hostname, friendly names, VIN/raw serial and arbitrary HAL metadata; unsupported architectures fail closed.
- Docs RESOURCE_BUDGETS.md and UNIVERSAL_NATIVE.md updated.

## Verification
- Targeted tests: 5 packages OK.
- Targeted vet: PASS.
- Race: resource/controlkernel/swarm/installer-universal, 4 packages OK, no races.
- Codegen deterministic: manifest SHA256 45A4CEA408B5F4D496888E6561DF8D923C9E65BE029DF924C045D97B3D9FC4A0; Go DTO 325E16B085BFB939BC265365E00D1FDD5A9791849E3693BDCE560C994389C1A1.
- Scoped git diff --check PASS; only existing LF->CRLF warnings.
- Full gate: go vet ./... + go test -count=1 -timeout 180s ./... => 45 tested packages OK, 0 failed.

## Benchmark sanity
- Report: E:\nexus\swypik-os\out\resource-bench-20260930-104523-93ec77\resource-results.json
- 1 run/profile: balanced steady WS 65.766 MiB; phone 28.333 MiB; performance 34.230 MiB; idle CPU 0% all.
- Use handoff 22 v7 for authoritative 3-run statistics.

## Next
1. Runtime ownership wiring: real OS/Compute Fabric owner opens Control Kernel journal and injects ResourceTransitionSink.
2. Consume Hardware Manifest/device class in the first-party device agent.
3. Real GPU/NPU cancellation/checkpoint/device-memory release when a real long-running kernel exists.
4. Scenario benchmarks with active training/search/agent/peers/device synthesis.
5. Generic CPU/platform thermal telemetry.
6. Continue native kernel/device ABI + real network/storage/input/display drivers.
