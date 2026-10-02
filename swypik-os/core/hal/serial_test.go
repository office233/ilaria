package hal

import (
	"context"
	"testing"
)

func TestSerialNodeDoesNotImplyRobot(t *testing.T) {
	for _, path := range []string{"/dev/ttyS0", "/dev/ttyACM0", "/dev/ttyUSB0"} {
		d := describeSerialEndpoint(path)
		if d.Class != ClassUnknown || d.Bus != BusUART || len(d.Capabilities) != 0 || d.DriverStatus != DriverGeneric {
			t.Fatalf("invented peripheral capabilities: %+v", d)
		}
		m := NewManager()
		m.RegisterDevice(d)
		profile, err := m.Scan(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if profile.HostType != HostPC || len(m.ListDevicesByClass(ClassRobot)) != 0 {
			t.Fatalf("serial console changed host class: %+v", profile)
		}
	}
}
func TestRepeatedScanDoesNotDuplicateInventory(t *testing.T) {
	m := NewManager()
	m.RegisterDevice(describeSerialEndpoint("/dev/ttyS0"))
	for i := 0; i < 2; i++ {
		p, err := m.Scan(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, d := range p.Devices {
			if seen[d.ID] {
				t.Fatalf("duplicate device %s", d.ID)
			}
			seen[d.ID] = true
		}
	}
}
