package resource

import (
	"math"
	"testing"
	"time"
)

type fixtureEnergyReader struct {
	reads      []rawEnergyRead
	readCalls  int
	closeCalls int
}

func (r *fixtureEnergyReader) readEnergy() rawEnergyRead {
	r.readCalls++
	if len(r.reads) == 0 {
		return rawEnergyRead{Status: EnergyStatusUnavailable, Reason: "fixture_exhausted"}
	}
	index := r.readCalls - 1
	if index >= len(r.reads) {
		index = len(r.reads) - 1
	}
	return r.reads[index]
}

func (r *fixtureEnergyReader) close() error {
	r.closeCalls++
	return nil
}

func fixtureCounter(at time.Time, value uint64) rawEnergyCounter {
	return rawEnergyCounter{
		ID:         "fixture:0",
		Status:     EnergyStatusAvailable,
		Source:     "fixture",
		Scope:      "package",
		Domain:     "fixture-package",
		Unit:       EnergyUnitMicrojoule,
		Counter:    value,
		ObservedAt: at,
	}
}

func TestEnergySamplerIsOnDemandAndComputesMicrojouleDelta(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0, 2_000_000)}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0.Add(2*time.Second), 3_500_000)}},
	}}
	sampler := newEnergySampler(reader)
	if reader.readCalls != 0 {
		t.Fatalf("construction performed %d reads; want zero", reader.readCalls)
	}

	first := sampler.Sample()
	if first.Status != EnergyStatusAvailable || len(first.Counters) != 1 {
		t.Fatalf("first sample = %+v", first)
	}
	if first.Counters[0].DeltaStatus != EnergyDeltaBaseline {
		t.Fatalf("first delta status = %q; want baseline", first.Counters[0].DeltaStatus)
	}

	second := sampler.Sample()
	got := second.Counters[0]
	if got.DeltaStatus != EnergyDeltaMeasured {
		t.Fatalf("second delta status = %q (%s)", got.DeltaStatus, got.DeltaReason)
	}
	if math.Abs(got.DeltaJoules-1.5) > 1e-12 {
		t.Fatalf("delta joules = %.12f; want 1.5", got.DeltaJoules)
	}
	if got.Interval != 2*time.Second {
		t.Fatalf("interval = %s; want 2s", got.Interval)
	}
	if reader.readCalls != 2 {
		t.Fatalf("read calls = %d; want 2", reader.readCalls)
	}
}

func TestEnergySamplerPicowattHourUsesSourceTimestamp(t *testing.T) {
	base := rawEnergyCounter{
		ID:                  "emi:0",
		Status:              EnergyStatusAvailable,
		Source:              "windows_emi",
		Scope:               "emi_channel",
		Domain:              "fixture-channel",
		Unit:                EnergyUnitPicowattHour,
		Counter:             5_000_000_000,
		ObservedAt:          time.Unix(10, 0),
		SourceTimestamp:     100,
		SourceTimestampUnit: "100ns",
	}
	next := base
	next.Counter += 1_000_000_000
	next.ObservedAt = base.ObservedAt.Add(30 * time.Second)
	next.SourceTimestamp += 20_000_000
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{base}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{next}},
	}}
	sampler := newEnergySampler(reader)
	_ = sampler.Sample()
	got := sampler.Sample().Counters[0]
	if got.DeltaStatus != EnergyDeltaMeasured {
		t.Fatalf("delta status = %q (%s)", got.DeltaStatus, got.DeltaReason)
	}
	if math.Abs(got.DeltaJoules-3.6) > 1e-12 {
		t.Fatalf("delta joules = %.12f; want 3.6", got.DeltaJoules)
	}
	if got.Interval != 2*time.Second {
		t.Fatalf("interval = %s; want EMI 100ns timestamp interval 2s", got.Interval)
	}
}

func TestEnergySamplerCounterDecreaseWithRangeIsAmbiguous(t *testing.T) {
	t0 := time.Unix(100, 0)
	first := fixtureCounter(t0, 900)
	first.CounterRange = 1_000
	second := fixtureCounter(t0.Add(time.Second), 100)
	second.CounterRange = 1_000
	third := fixtureCounter(t0.Add(2*time.Second), 160)
	third.CounterRange = 1_000
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{first}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{second}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{third}},
	}}
	sampler := newEnergySampler(reader)
	_ = sampler.Sample()
	decrease := sampler.Sample().Counters[0]
	if decrease.DeltaStatus != EnergyDeltaUnavailable || decrease.DeltaReason != "counter_decreased_wrap_or_reset" {
		t.Fatalf("decrease = %+v", decrease)
	}
	if decrease.DeltaJoules != 0 {
		t.Fatalf("ambiguous wrap/reset fabricated %.12f J", decrease.DeltaJoules)
	}
	recovered := sampler.Sample().Counters[0]
	if recovered.DeltaStatus != EnergyDeltaMeasured {
		t.Fatalf("recovered delta = %+v", recovered)
	}
	if math.Abs(recovered.DeltaJoules-60e-6) > 1e-15 {
		t.Fatalf("recovered joules = %.15f; want %.15f", recovered.DeltaJoules, 60e-6)
	}
}

func TestEnergySamplerCounterDecreaseWithoutRangeIsResetOrDiscontinuity(t *testing.T) {
	t0 := time.Unix(150, 0)
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0, 900)}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0.Add(time.Second), 100)}},
	}}
	sampler := newEnergySampler(reader)
	_ = sampler.Sample()
	got := sampler.Sample().Counters[0]
	if got.DeltaStatus != EnergyDeltaUnavailable || got.DeltaReason != "counter_decreased_or_reset" {
		t.Fatalf("decrease without range = %+v", got)
	}
	if got.DeltaJoules != 0 {
		t.Fatalf("reset/discontinuity fabricated %.12f J", got.DeltaJoules)
	}
}

func TestEnergySamplerUnavailableReadBreaksContinuity(t *testing.T) {
	t0 := time.Unix(200, 0)
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0, 10)}},
		{Status: EnergyStatusUnavailable, Reason: "permission_denied"},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{fixtureCounter(t0.Add(2*time.Second), 20)}},
	}}
	sampler := newEnergySampler(reader)
	_ = sampler.Sample()
	unavailable := sampler.Sample()
	if unavailable.Status != EnergyStatusUnavailable || unavailable.Reason != "permission_denied" {
		t.Fatalf("unavailable sample = %+v", unavailable)
	}
	recovered := sampler.Sample().Counters[0]
	if recovered.DeltaStatus != EnergyDeltaBaseline {
		t.Fatalf("sample after discontinuity = %+v; want new baseline", recovered)
	}
}

func TestEnergySamplerMetadataChangeDoesNotCreateDelta(t *testing.T) {
	t0 := time.Unix(300, 0)
	first := fixtureCounter(t0, 10)
	second := fixtureCounter(t0.Add(time.Second), 20)
	second.Domain = "different-domain"
	reader := &fixtureEnergyReader{reads: []rawEnergyRead{
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{first}},
		{Status: EnergyStatusAvailable, Counters: []rawEnergyCounter{second}},
	}}
	sampler := newEnergySampler(reader)
	_ = sampler.Sample()
	got := sampler.Sample().Counters[0]
	if got.DeltaStatus != EnergyDeltaUnavailable || got.DeltaReason != "counter_metadata_changed" {
		t.Fatalf("metadata change = %+v", got)
	}
}

func TestEnergySamplerCloseIsIdempotent(t *testing.T) {
	reader := &fixtureEnergyReader{}
	sampler := newEnergySampler(reader)
	if err := sampler.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sampler.Close(); err != nil {
		t.Fatal(err)
	}
	if reader.closeCalls != 1 {
		t.Fatalf("close calls = %d; want 1", reader.closeCalls)
	}
	got := sampler.Sample()
	if got.Status != EnergyStatusUnavailable || got.Reason != "sampler_closed" {
		t.Fatalf("sample after close = %+v", got)
	}
}

func TestZeroValueEnergySamplerIsUnavailableWithoutPanic(t *testing.T) {
	var sampler EnergySampler
	got := sampler.Sample()
	if got.Status != EnergyStatusUnavailable || got.Reason != "reader_unavailable" {
		t.Fatalf("zero-value sample = %+v", got)
	}
	if err := sampler.Close(); err != nil {
		t.Fatal(err)
	}
}
