//go:build windows

package resource

import (
	"encoding/binary"
	"errors"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	windowsEMIVersionV1 = 1
	windowsEMIVersionV2 = 2

	windowsEMIMeasurementUnitPicowattHours = 0
	windowsEMIMetadataMaxBytes             = 1 << 20
	windowsEMIDeviceDetailMaxBytes         = 1 << 20
	windowsEMIMaxChannels                  = 4096
	windowsEMIChannelMeasurementBytes      = 16

	// CTL_CODE(FILE_DEVICE_UNKNOWN=0x22, function, METHOD_BUFFERED=0,
	// FILE_READ_ACCESS=1). These values are the public EMI ABI from emi.h.
	ioctlEMIGetVersion      = (0x22 << 16) | (1 << 14) | (0 << 2)
	ioctlEMIGetMetadataSize = (0x22 << 16) | (1 << 14) | (1 << 2)
	ioctlEMIGetMetadata     = (0x22 << 16) | (1 << 14) | (2 << 2)
	ioctlEMIGetMeasurement  = (0x22 << 16) | (1 << 14) | (3 << 2)

	digcfPresent         = 0x00000002
	digcfDeviceInterface = 0x00000010
)

var (
	// GUID_DEVICE_ENERGY_METER:
	// {45BD8344-7ED6-49cf-A440-C276C933B053}.
	windowsEnergyMeterGUID = windows.GUID{
		Data1: 0x45bd8344,
		Data2: 0x7ed6,
		Data3: 0x49cf,
		Data4: [8]byte{0xa4, 0x40, 0xc2, 0x76, 0xc9, 0x33, 0xb0, 0x53},
	}

	windowsSetupAPIDLL                      = windows.NewLazySystemDLL("setupapi.dll")
	windowsSetupDiGetClassDevsW             = windowsSetupAPIDLL.NewProc("SetupDiGetClassDevsW")
	windowsSetupDiEnumDeviceInterfaces      = windowsSetupAPIDLL.NewProc("SetupDiEnumDeviceInterfaces")
	windowsSetupDiGetDeviceInterfaceDetailW = windowsSetupAPIDLL.NewProc("SetupDiGetDeviceInterfaceDetailW")
	windowsSetupDiDestroyDeviceInfoList     = windowsSetupAPIDLL.NewProc("SetupDiDestroyDeviceInfoList")
	errWindowsEMIUnsupported                = errors.New("unsupported EMI counter")
	errWindowsEMIInvalidMetadata            = errors.New("invalid EMI metadata")
	errWindowsEMIOutputSize                 = errors.New("invalid EMI output size")
)

type windowsDeviceInterfaceData struct {
	CbSize             uint32
	InterfaceClassGUID windows.GUID
	Flags              uint32
	Reserved           uintptr
}

type windowsEMIChannel struct {
	domain string
	scope  string
}

type windowsEMIDevice struct {
	handle   windows.Handle
	index    int
	channels []windowsEMIChannel
}

type windowsEnergyReader struct {
	discovered bool
	devices    []windowsEMIDevice
	reason     string
}

func newPlatformEnergyReader() energyReader {
	return &windowsEnergyReader{}
}

func (r *windowsEnergyReader) discover() {
	r.discovered = true
	paths, err := windowsEMIDevicePaths()
	if err != nil {
		r.reason = windowsEnergyReason(err, "discovery_failed")
		return
	}
	if len(paths) == 0 {
		r.reason = "no_counter"
		return
	}

	permissionDenied := false
	unsupported := false
	invalidMetadata := false
	for index, path := range paths {
		pathUTF16, err := windows.UTF16PtrFromString(path)
		if err != nil {
			invalidMetadata = true
			continue
		}
		handle, err := windows.CreateFile(
			pathUTF16,
			windows.GENERIC_READ,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
			nil,
			windows.OPEN_EXISTING,
			windows.FILE_ATTRIBUTE_NORMAL,
			0,
		)
		if err != nil {
			permissionDenied = permissionDenied || errors.Is(err, windows.ERROR_ACCESS_DENIED)
			continue
		}

		channels, err := windowsReadEMIMetadata(handle)
		if err != nil {
			permissionDenied = permissionDenied || errors.Is(err, windows.ERROR_ACCESS_DENIED)
			unsupported = unsupported || errors.Is(err, errWindowsEMIUnsupported)
			invalidMetadata = invalidMetadata || errors.Is(err, errWindowsEMIInvalidMetadata)
			_ = windows.CloseHandle(handle)
			continue
		}
		r.devices = append(r.devices, windowsEMIDevice{handle: handle, index: index, channels: channels})
	}

	if len(r.devices) != 0 {
		return
	}
	switch {
	case permissionDenied:
		r.reason = "permission_denied"
	case unsupported:
		r.reason = "unsupported_counter"
	case invalidMetadata:
		r.reason = "invalid_metadata"
	default:
		r.reason = "no_readable_counter"
	}
}

func (r *windowsEnergyReader) readEnergy() rawEnergyRead {
	if !r.discovered {
		r.discover()
	}
	if len(r.devices) == 0 {
		return rawEnergyRead{Status: EnergyStatusUnavailable, Reason: r.reason}
	}

	result := rawEnergyRead{Status: EnergyStatusUnavailable}
	permissionDenied := false
	for _, device := range r.devices {
		measurements, err := windowsReadEMIMeasurements(device.handle, len(device.channels))
		if err != nil {
			reason := windowsEnergyReason(err, "read_failed")
			permissionDenied = permissionDenied || reason == "permission_denied"
			for channelIndex, channel := range device.channels {
				result.Counters = append(result.Counters, rawEnergyCounter{
					ID:         windowsEMICounterID(device.index, channelIndex),
					Status:     EnergyStatusUnavailable,
					Reason:     reason,
					Source:     "windows_emi",
					Scope:      channel.scope,
					Domain:     channel.domain,
					Unit:       EnergyUnitPicowattHour,
					ObservedAt: time.Now(),
				})
			}
			continue
		}

		observedAt := time.Now()
		for channelIndex, measurement := range measurements {
			channel := device.channels[channelIndex]
			result.Counters = append(result.Counters, rawEnergyCounter{
				ID:                  windowsEMICounterID(device.index, channelIndex),
				Status:              EnergyStatusAvailable,
				Source:              "windows_emi",
				Scope:               channel.scope,
				Domain:              channel.domain,
				Unit:                EnergyUnitPicowattHour,
				Counter:             measurement.energy,
				ObservedAt:          observedAt,
				SourceTimestamp:     measurement.timestamp100ns,
				SourceTimestampUnit: "100ns",
			})
			result.Status = EnergyStatusAvailable
		}
	}
	if result.Status != EnergyStatusAvailable {
		if permissionDenied {
			result.Reason = "permission_denied"
		} else {
			result.Reason = "no_readable_counter"
		}
	}
	return result
}

func (r *windowsEnergyReader) close() error {
	var firstErr error
	for index := range r.devices {
		if r.devices[index].handle == 0 || r.devices[index].handle == windows.InvalidHandle {
			continue
		}
		if err := windows.CloseHandle(r.devices[index].handle); err != nil && firstErr == nil {
			firstErr = err
		}
		r.devices[index].handle = 0
	}
	return firstErr
}

func windowsEMICounterID(deviceIndex, channelIndex int) string {
	return fmt.Sprintf("windows_emi:%d:%d", deviceIndex, channelIndex)
}

func windowsEnergyReason(err error, fallback string) string {
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return "permission_denied"
	}
	if errors.Is(err, errWindowsEMIUnsupported) {
		return "unsupported_counter"
	}
	if errors.Is(err, errWindowsEMIInvalidMetadata) {
		return "invalid_metadata"
	}
	if errors.Is(err, errWindowsEMIOutputSize) {
		return "invalid_output_size"
	}
	return fallback
}

func windowsEMIDevicePaths() ([]string, error) {
	devInfoRaw, _, callErr := windowsSetupDiGetClassDevsW.Call(
		uintptr(unsafe.Pointer(&windowsEnergyMeterGUID)),
		0,
		0,
		digcfPresent|digcfDeviceInterface,
	)
	devInfo := windows.Handle(devInfoRaw)
	if devInfo == windows.InvalidHandle {
		return nil, callErr
	}
	defer windowsSetupDiDestroyDeviceInfoList.Call(uintptr(devInfo))

	var paths []string
	for memberIndex := 0; ; memberIndex++ {
		interfaceData := windowsDeviceInterfaceData{CbSize: uint32(unsafe.Sizeof(windowsDeviceInterfaceData{}))}
		ok, _, err := windowsSetupDiEnumDeviceInterfaces.Call(
			uintptr(devInfo),
			0,
			uintptr(unsafe.Pointer(&windowsEnergyMeterGUID)),
			uintptr(memberIndex),
			uintptr(unsafe.Pointer(&interfaceData)),
		)
		if ok == 0 {
			if errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
				break
			}
			return nil, err
		}
		path, err := windowsEMIDevicePath(devInfo, &interfaceData)
		if err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func windowsEMIDevicePath(devInfo windows.Handle, interfaceData *windowsDeviceInterfaceData) (string, error) {
	var required uint32
	ok, _, err := windowsSetupDiGetDeviceInterfaceDetailW.Call(
		uintptr(devInfo),
		uintptr(unsafe.Pointer(interfaceData)),
		0,
		0,
		uintptr(unsafe.Pointer(&required)),
		0,
	)
	if ok != 0 || !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
		if ok != 0 {
			return "", fmt.Errorf("SetupDiGetDeviceInterfaceDetailW size query unexpectedly succeeded")
		}
		return "", err
	}
	if required < 6 || required > windowsEMIDeviceDetailMaxBytes {
		return "", fmt.Errorf("%w: device interface detail size", errWindowsEMIInvalidMetadata)
	}

	buffer := make([]byte, required)
	binary.LittleEndian.PutUint32(buffer[:4], windowsDeviceInterfaceDetailCBSize())
	ok, _, err = windowsSetupDiGetDeviceInterfaceDetailW.Call(
		uintptr(devInfo),
		uintptr(unsafe.Pointer(interfaceData)),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(required),
		uintptr(unsafe.Pointer(&required)),
		0,
	)
	if ok == 0 {
		return "", err
	}
	path, err := windowsUTF16Bytes(buffer[4:])
	if err != nil || path == "" {
		return "", fmt.Errorf("%w: device path", errWindowsEMIInvalidMetadata)
	}
	return path, nil
}

func windowsDeviceInterfaceDetailCBSize() uint32 {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		return 8
	}
	return 6
}

func windowsReadEMIMetadata(handle windows.Handle) ([]windowsEMIChannel, error) {
	versionBuffer := make([]byte, 2)
	if err := windowsEMIIoctlExact(handle, ioctlEMIGetVersion, versionBuffer); err != nil {
		return nil, err
	}
	version := binary.LittleEndian.Uint16(versionBuffer)
	if version != windowsEMIVersionV1 && version != windowsEMIVersionV2 {
		return nil, fmt.Errorf("%w: version %d", errWindowsEMIUnsupported, version)
	}

	sizeBuffer := make([]byte, 4)
	if err := windowsEMIIoctlExact(handle, ioctlEMIGetMetadataSize, sizeBuffer); err != nil {
		return nil, err
	}
	metadataSize := binary.LittleEndian.Uint32(sizeBuffer)
	if metadataSize == 0 || metadataSize > windowsEMIMetadataMaxBytes {
		return nil, fmt.Errorf("%w: metadata size", errWindowsEMIInvalidMetadata)
	}

	metadata := make([]byte, metadataSize)
	if err := windowsEMIIoctlExact(handle, ioctlEMIGetMetadata, metadata); err != nil {
		return nil, err
	}
	return windowsParseEMIMetadata(version, metadata)
}

func windowsParseEMIMetadata(version uint16, metadata []byte) ([]windowsEMIChannel, error) {
	switch version {
	case windowsEMIVersionV1:
		return windowsParseEMIMetadataV1(metadata)
	case windowsEMIVersionV2:
		return windowsParseEMIMetadataV2(metadata)
	default:
		return nil, fmt.Errorf("%w: version %d", errWindowsEMIUnsupported, version)
	}
}

func windowsParseEMIMetadataV1(metadata []byte) ([]windowsEMIChannel, error) {
	const (
		measurementUnitOffset = 0
		nameSizeOffset        = 70
		nameOffset            = 72
	)
	if len(metadata) < nameOffset+2 {
		return nil, fmt.Errorf("%w: v1 metadata too short", errWindowsEMIInvalidMetadata)
	}
	if binary.LittleEndian.Uint32(metadata[measurementUnitOffset:]) != windowsEMIMeasurementUnitPicowattHours {
		return nil, errWindowsEMIUnsupported
	}
	nameSize := int(binary.LittleEndian.Uint16(metadata[nameSizeOffset:]))
	if nameSize < 2 || nameSize%2 != 0 || nameSize > len(metadata)-nameOffset {
		return nil, fmt.Errorf("%w: v1 metered hardware name", errWindowsEMIInvalidMetadata)
	}
	domain, err := windowsUTF16BytesExact(metadata[nameOffset : nameOffset+nameSize])
	if err != nil || domain == "" {
		return nil, fmt.Errorf("%w: v1 metered hardware name", errWindowsEMIInvalidMetadata)
	}
	return []windowsEMIChannel{{domain: domain, scope: "metered_hardware"}}, nil
}

func windowsParseEMIMetadataV2(metadata []byte) ([]windowsEMIChannel, error) {
	const (
		channelCountOffset = 66
		channelsOffset     = 68
		channelHeaderBytes = 6
	)
	if len(metadata) < channelsOffset+8 {
		return nil, fmt.Errorf("%w: v2 metadata too short", errWindowsEMIInvalidMetadata)
	}
	channelCount := int(binary.LittleEndian.Uint16(metadata[channelCountOffset:]))
	if channelCount == 0 || channelCount > windowsEMIMaxChannels {
		return nil, fmt.Errorf("%w: v2 channel count", errWindowsEMIInvalidMetadata)
	}

	channels := make([]windowsEMIChannel, 0, channelCount)
	offset := channelsOffset
	for index := 0; index < channelCount; index++ {
		if !windowsValidEMIChannelLayout(metadata, offset) {
			return nil, fmt.Errorf("%w: v2 channel %d", errWindowsEMIInvalidMetadata, index)
		}
		if binary.LittleEndian.Uint32(metadata[offset:]) != windowsEMIMeasurementUnitPicowattHours {
			return nil, errWindowsEMIUnsupported
		}
		nameSize := int(binary.LittleEndian.Uint16(metadata[offset+4:]))
		nameStart := offset + channelHeaderBytes
		domain, err := windowsUTF16BytesExact(metadata[nameStart : nameStart+nameSize])
		if err != nil || domain == "" {
			return nil, fmt.Errorf("%w: v2 channel %d name", errWindowsEMIInvalidMetadata, index)
		}
		channels = append(channels, windowsEMIChannel{domain: domain, scope: "emi_channel"})

		if index+1 == channelCount {
			continue
		}
		next := nameStart + nameSize
		if windowsValidSupportedEMIChannelHeader(metadata, next) {
			offset = next
			continue
		}
		aligned := (next + 3) &^ 3
		if aligned != next && windowsValidSupportedEMIChannelHeader(metadata, aligned) {
			offset = aligned
			continue
		}
		return nil, fmt.Errorf("%w: v2 channel %d next offset", errWindowsEMIInvalidMetadata, index)
	}
	return channels, nil
}

func windowsValidEMIChannelLayout(metadata []byte, offset int) bool {
	const channelHeaderBytes = 6
	if offset < 0 || offset > len(metadata)-8 {
		return false
	}
	nameSize := int(binary.LittleEndian.Uint16(metadata[offset+4:]))
	return nameSize >= 2 && nameSize%2 == 0 && nameSize <= len(metadata)-(offset+channelHeaderBytes)
}

func windowsValidSupportedEMIChannelHeader(metadata []byte, offset int) bool {
	return windowsValidEMIChannelLayout(metadata, offset) &&
		binary.LittleEndian.Uint32(metadata[offset:]) == windowsEMIMeasurementUnitPicowattHours
}

func windowsUTF16BytesExact(data []byte) (string, error) {
	if len(data) < 2 || len(data)%2 != 0 || binary.LittleEndian.Uint16(data[len(data)-2:]) != 0 {
		return "", fmt.Errorf("invalid terminated UTF-16")
	}
	for offset := 0; offset < len(data)-2; offset += 2 {
		if binary.LittleEndian.Uint16(data[offset:]) == 0 {
			return "", fmt.Errorf("embedded UTF-16 terminator")
		}
	}
	return windowsUTF16Bytes(data)
}

func windowsUTF16Bytes(data []byte) (string, error) {
	if len(data)%2 != 0 {
		return "", fmt.Errorf("invalid UTF-16 byte length")
	}
	values := make([]uint16, 0, len(data)/2)
	terminated := false
	for offset := 0; offset+1 < len(data); offset += 2 {
		value := binary.LittleEndian.Uint16(data[offset:])
		if value == 0 {
			terminated = true
			break
		}
		values = append(values, value)
	}
	if !terminated {
		return "", fmt.Errorf("unterminated UTF-16")
	}
	return windows.UTF16ToString(values), nil
}

type windowsEMIMeasurement struct {
	energy         uint64
	timestamp100ns uint64
}

func windowsReadEMIMeasurements(handle windows.Handle, channelCount int) ([]windowsEMIMeasurement, error) {
	if channelCount <= 0 || channelCount > windowsEMIMaxChannels {
		return nil, errWindowsEMIOutputSize
	}
	buffer := make([]byte, channelCount*windowsEMIChannelMeasurementBytes)
	if err := windowsEMIIoctlExact(handle, ioctlEMIGetMeasurement, buffer); err != nil {
		return nil, err
	}
	measurements := make([]windowsEMIMeasurement, channelCount)
	for index := range measurements {
		offset := index * windowsEMIChannelMeasurementBytes
		measurements[index] = windowsEMIMeasurement{
			energy:         binary.LittleEndian.Uint64(buffer[offset:]),
			timestamp100ns: binary.LittleEndian.Uint64(buffer[offset+8:]),
		}
	}
	return measurements, nil
}

func windowsEMIIoctlExact(handle windows.Handle, code uint32, output []byte) error {
	if len(output) == 0 {
		return fmt.Errorf("empty EMI output buffer")
	}
	var returned uint32
	err := windows.DeviceIoControl(
		handle,
		code,
		nil,
		0,
		&output[0],
		uint32(len(output)),
		&returned,
		nil,
	)
	if err != nil {
		return err
	}
	if returned != uint32(len(output)) {
		return fmt.Errorf("%w: got %d want %d", errWindowsEMIOutputSize, returned, len(output))
	}
	return nil
}
