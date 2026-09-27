package bci

import (
	"math"
	"testing"
	"time"
)

func TestBCIProcessor(t *testing.T) {
	proc := NewProcessor(250.0, 32)

	// 1. Test Idle state
	for i := 0; i < 32; i++ {
		proc.PushFrame(BioFrame{
			Timestamp: time.Now(),
			Channels:  [8]float64{2.0, 1.5, 3.0, 2.5, 1.0, 0.5, 1.2, 0.8},
		})
	}

	intent := proc.DecodeIntent()
	if intent.Intent != IntentIdle {
		t.Errorf("Expected idle intent for low-amplitude noise, got: %s", intent.Intent)
	}

	// 2. Test Emergency Brake (Bilateral high EMG clench > 50 uV on ch 0 & 1)
	for i := 0; i < 32; i++ {
		val := 90.0 * math.Sin(float64(i)*0.4)
		proc.PushFrame(BioFrame{
			Timestamp: time.Now(),
			Channels:  [8]float64{math.Abs(val) + 55.0, math.Abs(val) + 55.0, 5.0, 5.0, 0, 0, 0, 0},
		})
	}

	brakeIntent := proc.DecodeIntent()
	if brakeIntent.Intent != IntentBrake {
		t.Errorf("Expected emergency brake intent, got: %s", brakeIntent.Intent)
	}
	if brakeIntent.Confidence < 0.7 {
		t.Errorf("Expected high confidence for brake, got: %.2f", brakeIntent.Confidence)
	}

	// 3. Test Robotic Grasp (High Beta band oscillations on Channel 4)
	proc.Reset()
	for i := 0; i < 32; i++ {
		var osc float64 = 30.0
		if i%2 == 0 {
			osc = -30.0
		}
		proc.PushFrame(BioFrame{
			Timestamp: time.Now(),
			Channels:  [8]float64{5.0, 5.0, 5.0, 5.0, osc, 5.0, 5.0, 5.0},
		})
	}

	graspIntent := proc.DecodeIntent()
	if graspIntent.Intent != IntentGrasp {
		t.Errorf("Expected robotic grasp intent, got: %s", graspIntent.Intent)
	}

	// 4. Test Subvocal Confirmation (Laryngeal EMG activation on Channel 6)
	proc.Reset()
	for i := 0; i < 32; i++ {
		var subVal float64 = 40.0
		if i%3 == 0 {
			subVal = -40.0
		}
		proc.PushFrame(BioFrame{
			Timestamp: time.Now(),
			Channels:  [8]float64{5.0, 5.0, 5.0, 5.0, 5.0, 5.0, subVal, 5.0},
		})
	}

	confirmIntent := proc.DecodeIntent()
	if confirmIntent.Intent != IntentSubvocalConfirm {
		t.Errorf("Expected subvocal confirm intent, got: %s", confirmIntent.Intent)
	}
}
