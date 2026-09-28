// Package evidence names how much of a claimed device, network or physical
// effect was actually observed. Results below Connected describe process
// memory only and must never be worded as hardware or network activity.
package evidence

// Level is the strongest observation backing a result.
type Level string

const (
	// Simulated: no device or peer was involved; state lives in process memory.
	Simulated Level = "SIMULATED"
	// Emulated: a software model of the device protocol answered.
	Emulated Level = "EMULATED"
	// Connected: a real endpoint accepted I/O, but its response was not checked.
	Connected Level = "CONNECTED"
	// Verified: the endpoint's response was checked against its protocol.
	Verified Level = "VERIFIED"
	// Actuated: a physical effect was confirmed by independent telemetry.
	Actuated Level = "ACTUATED"
	// Failed: the operation was attempted and did not take effect.
	Failed Level = "FAILED"
)

// Real reports whether the level involved an actual endpoint.
func (l Level) Real() bool {
	return l == Connected || l == Verified || l == Actuated
}
