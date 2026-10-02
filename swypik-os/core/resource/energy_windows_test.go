//go:build windows

package resource

import (
	"encoding/binary"
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

func appendWindowsUTF16(value string) []byte {
	encoded, err := windows.UTF16FromString(value)
	if err != nil {
		panic(err)
	}
	data := make([]byte, len(encoded)*2)
	for index, part := range encoded {
		binary.LittleEndian.PutUint16(data[index*2:], part)
	}
	return data
}

func TestWindowsParseEMIMetadataV1Fixture(t *testing.T) {
	name := appendWindowsUTF16("fixture-package")
	metadata := make([]byte, 72+len(name))
	binary.LittleEndian.PutUint32(metadata[0:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[70:], uint16(len(name)))
	copy(metadata[72:], name)
	channels, err := windowsParseEMIMetadata(windowsEMIVersionV1, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 1 || channels[0].domain != "fixture-package" || channels[0].scope != "metered_hardware" {
		t.Fatalf("channels = %+v", channels)
	}
}

func TestWindowsParseEMIMetadataV2Fixture(t *testing.T) {
	firstName := appendWindowsUTF16("package")
	secondName := appendWindowsUTF16("dram")
	firstOffset := 68
	secondOffset := firstOffset + 6 + len(firstName)
	metadata := make([]byte, secondOffset+6+len(secondName))
	binary.LittleEndian.PutUint16(metadata[66:], 2)
	binary.LittleEndian.PutUint32(metadata[firstOffset:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[firstOffset+4:], uint16(len(firstName)))
	copy(metadata[firstOffset+6:], firstName)
	binary.LittleEndian.PutUint32(metadata[secondOffset:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[secondOffset+4:], uint16(len(secondName)))
	copy(metadata[secondOffset+6:], secondName)

	channels, err := windowsParseEMIMetadata(windowsEMIVersionV2, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 2 || channels[0].domain != "package" || channels[1].domain != "dram" {
		t.Fatalf("channels = %+v", channels)
	}
}

func TestWindowsParseEMIMetadataV2AlignedFixture(t *testing.T) {
	firstName := appendWindowsUTF16("a")
	secondName := appendWindowsUTF16("second")
	firstOffset := 68
	rawSecondOffset := firstOffset + 6 + len(firstName)
	secondOffset := (rawSecondOffset + 3) &^ 3
	if secondOffset == rawSecondOffset {
		t.Fatal("fixture does not require padding")
	}
	metadata := make([]byte, secondOffset+6+len(secondName))
	binary.LittleEndian.PutUint16(metadata[66:], 2)
	binary.LittleEndian.PutUint32(metadata[firstOffset:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[firstOffset+4:], uint16(len(firstName)))
	copy(metadata[firstOffset+6:], firstName)
	binary.LittleEndian.PutUint32(metadata[secondOffset:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[secondOffset+4:], uint16(len(secondName)))
	copy(metadata[secondOffset+6:], secondName)

	channels, err := windowsParseEMIMetadata(windowsEMIVersionV2, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if len(channels) != 2 || channels[0].domain != "a" || channels[1].domain != "second" {
		t.Fatalf("channels = %+v", channels)
	}
}

func TestWindowsParseEMIMetadataRejectsUnknownUnit(t *testing.T) {
	name := appendWindowsUTF16("fixture")
	metadata := make([]byte, 72+len(name))
	binary.LittleEndian.PutUint32(metadata[0:], 99)
	binary.LittleEndian.PutUint16(metadata[70:], uint16(len(name)))
	copy(metadata[72:], name)
	if _, err := windowsParseEMIMetadata(windowsEMIVersionV1, metadata); !errors.Is(err, errWindowsEMIUnsupported) {
		t.Fatalf("error = %v; want unsupported counter", err)
	}
}

func TestWindowsParseEMIMetadataRejectsEmbeddedNameTerminator(t *testing.T) {
	name := appendWindowsUTF16("fixture")
	binary.LittleEndian.PutUint16(name[4:], 0)
	metadata := make([]byte, 72+len(name))
	binary.LittleEndian.PutUint32(metadata[0:], windowsEMIMeasurementUnitPicowattHours)
	binary.LittleEndian.PutUint16(metadata[70:], uint16(len(name)))
	copy(metadata[72:], name)
	if _, err := windowsParseEMIMetadata(windowsEMIVersionV1, metadata); !errors.Is(err, errWindowsEMIInvalidMetadata) {
		t.Fatalf("error = %v; want invalid metadata", err)
	}
}

func TestWindowsEnergyCapabilityProbe(t *testing.T) {
	sampler := NewEnergySampler()
	defer sampler.Close()
	got := sampler.Sample()
	t.Logf("observed Windows EMI capability: status=%s reason=%s counters=%d", got.Status, got.Reason, len(got.Counters))
	for _, counter := range got.Counters {
		t.Logf("counter id=%s status=%s scope=%s domain=%q unit=%s reason=%s", counter.ID, counter.Status, counter.Scope, counter.Domain, counter.Unit, counter.Reason)
	}
}
