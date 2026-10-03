//go:build !linux && !windows

package resource

func newPlatformEnergyReader() energyReader {
	return unavailableEnergyReader{reason: "unsupported_platform"}
}
