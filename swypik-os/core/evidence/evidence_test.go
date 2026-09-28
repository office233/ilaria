package evidence

import "testing"

func TestRealLevels(t *testing.T) {
	for level, want := range map[Level]bool{
		Simulated: false, Emulated: false, Failed: false,
		Connected: true, Verified: true, Actuated: true,
	} {
		if got := level.Real(); got != want {
			t.Errorf("%s.Real() = %v, want %v", level, got, want)
		}
	}
}
