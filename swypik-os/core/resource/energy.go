package resource

import (
	"sync"
	"time"
)

// EnergyStatus describes whether a real platform counter was available.
type EnergyStatus string

const (
	EnergyStatusAvailable   EnergyStatus = "available"
	EnergyStatusUnavailable EnergyStatus = "unavailable"
)

// EnergyUnit is the raw cumulative unit reported by the underlying counter.
type EnergyUnit string

const (
	EnergyUnitMicrojoule   EnergyUnit = "microjoule"
	EnergyUnitPicowattHour EnergyUnit = "picowatt_hour"
)

// EnergyDeltaStatus distinguishes a baseline from a measured interval and an
// interval that could not be reported honestly.
type EnergyDeltaStatus string

const (
	EnergyDeltaBaseline    EnergyDeltaStatus = "baseline"
	EnergyDeltaMeasured    EnergyDeltaStatus = "measured"
	EnergyDeltaUnavailable EnergyDeltaStatus = "unavailable"
)

// EnergyCounterSample is one real cumulative energy counter observation.
// Scope/domain describe the hardware/OS counter itself; they never imply
// per-process attribution.
type EnergyCounterSample struct {
	ID                  string            `json:"id"`
	Status              EnergyStatus      `json:"status"`
	Reason              string            `json:"reason,omitempty"`
	Source              string            `json:"source"`
	Scope               string            `json:"scope"`
	Domain              string            `json:"domain,omitempty"`
	Unit                EnergyUnit        `json:"unit,omitempty"`
	Counter             uint64            `json:"counter"`
	CounterRange        uint64            `json:"counter_range,omitempty"`
	ObservedAt          time.Time         `json:"observed_at"`
	SourceTimestamp     uint64            `json:"source_timestamp,omitempty"`
	SourceTimestampUnit string            `json:"source_timestamp_unit,omitempty"`
	DeltaStatus         EnergyDeltaStatus `json:"delta_status"`
	DeltaReason         string            `json:"delta_reason,omitempty"`
	DeltaJoules         float64           `json:"delta_joules"`
	Interval            time.Duration     `json:"interval_ns,omitempty"`
}

// EnergySample is an on-demand snapshot. Status is available when at least one
// counter was read successfully.
type EnergySample struct {
	Status   EnergyStatus          `json:"status"`
	Reason   string                `json:"reason,omitempty"`
	Counters []EnergyCounterSample `json:"counters,omitempty"`
}

type rawEnergyCounter struct {
	ID                  string
	Status              EnergyStatus
	Reason              string
	Source              string
	Scope               string
	Domain              string
	Unit                EnergyUnit
	Counter             uint64
	CounterRange        uint64
	ObservedAt          time.Time
	SourceTimestamp     uint64
	SourceTimestampUnit string
}

type rawEnergyRead struct {
	Status   EnergyStatus
	Reason   string
	Counters []rawEnergyCounter
}

type energyReader interface {
	readEnergy() rawEnergyRead
	close() error
}

type unavailableEnergyReader struct{ reason string }

func (r unavailableEnergyReader) readEnergy() rawEnergyRead {
	return rawEnergyRead{Status: EnergyStatusUnavailable, Reason: r.reason}
}

func (unavailableEnergyReader) close() error { return nil }

// EnergySampler keeps only the previous on-demand sample needed for a delta.
// It starts no goroutine, timer or polling loop.
type EnergySampler struct {
	mu       sync.Mutex
	reader   energyReader
	previous map[string]rawEnergyCounter
	closed   bool
}

// NewEnergySampler constructs a lazy platform sampler. Platform discovery and
// counter I/O happen only when Sample is called.
func NewEnergySampler() *EnergySampler {
	return newEnergySampler(newPlatformEnergyReader())
}

func newEnergySampler(reader energyReader) *EnergySampler {
	if reader == nil {
		reader = unavailableEnergyReader{reason: "reader_unavailable"}
	}
	return &EnergySampler{reader: reader, previous: make(map[string]rawEnergyCounter)}
}

// Sample reads real cumulative counters and derives interval energy only when
// the current/previous observations form a monotonic, unambiguous interval.
func (s *EnergySampler) Sample() EnergySample {
	if s == nil {
		return EnergySample{Status: EnergyStatusUnavailable, Reason: "sampler_nil"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return EnergySample{Status: EnergyStatusUnavailable, Reason: "sampler_closed"}
	}
	if s.reader == nil {
		return EnergySample{Status: EnergyStatusUnavailable, Reason: "reader_unavailable"}
	}
	if s.previous == nil {
		s.previous = make(map[string]rawEnergyCounter)
	}

	raw := s.reader.readEnergy()
	if len(raw.Counters) == 0 {
		if raw.Status == "" {
			raw.Status = EnergyStatusUnavailable
		}
		if raw.Status == EnergyStatusUnavailable {
			clear(s.previous)
		}
		return EnergySample{Status: raw.Status, Reason: raw.Reason}
	}

	result := EnergySample{Status: EnergyStatusUnavailable, Reason: raw.Reason}
	seen := make(map[string]struct{}, len(raw.Counters))
	result.Counters = make([]EnergyCounterSample, 0, len(raw.Counters))
	for _, current := range raw.Counters {
		counter := EnergyCounterSample{
			ID:                  current.ID,
			Status:              current.Status,
			Reason:              current.Reason,
			Source:              current.Source,
			Scope:               current.Scope,
			Domain:              current.Domain,
			Unit:                current.Unit,
			Counter:             current.Counter,
			CounterRange:        current.CounterRange,
			ObservedAt:          current.ObservedAt,
			SourceTimestamp:     current.SourceTimestamp,
			SourceTimestampUnit: current.SourceTimestampUnit,
			DeltaStatus:         EnergyDeltaUnavailable,
		}

		if _, duplicate := seen[current.ID]; duplicate || current.ID == "" {
			counter.Status = EnergyStatusUnavailable
			counter.Reason = "duplicate_or_empty_counter_id"
			counter.DeltaReason = counter.Reason
			delete(s.previous, current.ID)
			result.Counters = append(result.Counters, counter)
			continue
		}
		seen[current.ID] = struct{}{}

		if current.Status != EnergyStatusAvailable {
			if counter.Reason == "" {
				counter.Reason = "counter_unavailable"
			}
			counter.DeltaReason = counter.Reason
			delete(s.previous, current.ID)
			result.Counters = append(result.Counters, counter)
			continue
		}
		counter.Status = EnergyStatusAvailable
		result.Status = EnergyStatusAvailable
		result.Reason = ""
		previous, ok := s.previous[current.ID]
		if !ok {
			counter.DeltaStatus = EnergyDeltaBaseline
			s.previous[current.ID] = current
			result.Counters = append(result.Counters, counter)
			continue
		}

		if previous.Source != current.Source || previous.Scope != current.Scope ||
			previous.Domain != current.Domain || previous.Unit != current.Unit ||
			previous.CounterRange != current.CounterRange {
			counter.DeltaReason = "counter_metadata_changed"
			s.previous[current.ID] = current
			result.Counters = append(result.Counters, counter)
			continue
		}

		interval, intervalOK, intervalReason := energyInterval(previous, current)
		if !intervalOK {
			counter.DeltaReason = intervalReason
			s.previous[current.ID] = current
			result.Counters = append(result.Counters, counter)
			continue
		}
		counter.Interval = interval

		if current.Counter < previous.Counter {
			if current.CounterRange != 0 {
				counter.DeltaReason = "counter_decreased_wrap_or_reset"
			} else {
				counter.DeltaReason = "counter_decreased_or_reset"
			}
			s.previous[current.ID] = current
			result.Counters = append(result.Counters, counter)
			continue
		}

		joules, ok := rawEnergyToJoules(current.Unit, current.Counter-previous.Counter)
		if !ok {
			counter.DeltaReason = "unsupported_energy_unit"
			s.previous[current.ID] = current
			result.Counters = append(result.Counters, counter)
			continue
		}
		counter.DeltaStatus = EnergyDeltaMeasured
		counter.DeltaJoules = joules
		s.previous[current.ID] = current
		result.Counters = append(result.Counters, counter)
	}
	if result.Status != EnergyStatusAvailable && result.Reason == "" {
		result.Reason = "no_readable_counter"
	}
	return result
}

func energyInterval(previous, current rawEnergyCounter) (time.Duration, bool, string) {
	if previous.SourceTimestampUnit != "" || current.SourceTimestampUnit != "" {
		if previous.SourceTimestampUnit == "" || current.SourceTimestampUnit == "" {
			return 0, false, "source_timestamp_availability_changed"
		}
		if previous.SourceTimestampUnit != current.SourceTimestampUnit {
			return 0, false, "source_timestamp_unit_changed"
		}
		if current.SourceTimestamp <= previous.SourceTimestamp {
			if current.SourceTimestamp == previous.SourceTimestamp {
				return 0, false, "source_timestamp_not_advanced"
			}
			return 0, false, "source_timestamp_decreased"
		}
		delta := current.SourceTimestamp - previous.SourceTimestamp
		switch current.SourceTimestampUnit {
		case "100ns":
			const maxTicks = uint64((1<<63 - 1) / 100)
			if delta > maxTicks {
				return 0, false, "source_timestamp_interval_overflow"
			}
			return time.Duration(delta * 100), true, ""
		default:
			return 0, false, "unsupported_source_timestamp_unit"
		}
	}
	interval := current.ObservedAt.Sub(previous.ObservedAt)
	if interval <= 0 {
		return 0, false, "observation_timestamp_not_monotonic"
	}
	return interval, true, ""
}

func rawEnergyToJoules(unit EnergyUnit, delta uint64) (float64, bool) {
	switch unit {
	case EnergyUnitMicrojoule:
		const perJoule = uint64(1_000_000)
		return float64(delta/perJoule) + float64(delta%perJoule)/float64(perJoule), true
	case EnergyUnitPicowattHour:
		const billion = uint64(1_000_000_000)
		return float64(delta/billion)*3.6 + float64(delta%billion)*3.6e-9, true
	default:
		return 0, false
	}
}

// Close releases platform handles. It is idempotent.
func (s *EnergySampler) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	clear(s.previous)
	if s.reader == nil {
		return nil
	}
	return s.reader.close()
}
