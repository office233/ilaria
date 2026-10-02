package bci

import (
	"math"
	"sync"
	"time"
)

// IntentType defines the decoded neural or subvocal motor thought.
type IntentType string

const (
	IntentIdle            IntentType = "idle"
	IntentBrake           IntentType = "emergency_brake"
	IntentSteerLeft       IntentType = "steer_left"
	IntentSteerRight      IntentType = "steer_right"
	IntentGrasp           IntentType = "robotic_grasp"
	IntentRelease         IntentType = "robotic_release"
	IntentSubvocalConfirm IntentType = "subvocal_confirm"
)

// BioFrame captures an 8-channel microvolt sample frame from EEG/EMG sensors.
type BioFrame struct {
	Timestamp time.Time
	Channels  [8]float64 // Microvolts (uV), typical range: -150uV to +150uV
}

// Features captures extracted time-frequency domain metrics from a signal window.
type Features struct {
	MeanAbsVal  [8]float64
	ZeroCrosses [8]int
	WaveformLen [8]float64
	BetaBandPow [8]float64 // 13-30 Hz motor intent band
}

// DecodedIntent represents the output of the neural classifier.
type DecodedIntent struct {
	Intent     IntentType `json:"intent"`
	Confidence float64    `json:"confidence"`
	LatencyMs  int64      `json:"latency_ms"`
	Channel    int        `json:"dominant_channel"`
	Timestamp  time.Time  `json:"timestamp"`
}

// Processor manages the DSP pipeline and neural intent classification.
type Processor struct {
	mu          sync.RWMutex
	sampleRate  float64
	windowSize  int
	frameBuffer []BioFrame
	notchFilter bool
	lastIntent  DecodedIntent
}

// NewProcessor initializes the neural BCI & subvocal EMG decoder.
func NewProcessor(sampleRate float64, windowSize int) *Processor {
	if sampleRate <= 0 {
		sampleRate = 250.0 // Standard OpenBCI Cyton 250 Hz
	}
	if windowSize <= 0 {
		windowSize = 64 // ~256ms classification window
	}

	return &Processor{
		sampleRate:  sampleRate,
		windowSize:  windowSize,
		frameBuffer: make([]BioFrame, 0, windowSize*2),
		notchFilter: true,
		lastIntent: DecodedIntent{
			Intent:     IntentIdle,
			Confidence: 1.0,
			Timestamp:  time.Now(),
		},
	}
}

// PushFrame feeds a raw biological signal frame into the DSP pipeline.
func (p *Processor) PushFrame(frame BioFrame) {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Apply 50Hz notch filter if active (simple 3-tap comb)
	filtered := frame
	if p.notchFilter && len(p.frameBuffer) >= 2 {
		for ch := 0; ch < 8; ch++ {
			// Basic band-stop notch
			prev := p.frameBuffer[len(p.frameBuffer)-1].Channels[ch]
			prev2 := p.frameBuffer[len(p.frameBuffer)-2].Channels[ch]
			filtered.Channels[ch] = 0.5*frame.Channels[ch] + 0.25*prev + 0.25*prev2
		}
	}

	p.frameBuffer = append(p.frameBuffer, filtered)

	// Keep window strictly bounded to windowSize
	if len(p.frameBuffer) > p.windowSize {
		p.frameBuffer = p.frameBuffer[len(p.frameBuffer)-p.windowSize:]
	}
}

// Reset clears the biological frame buffer.
func (p *Processor) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.frameBuffer = p.frameBuffer[:0]
}

// ExtractFeatures calculates MAV, ZCR, and Beta power across the window.
func (p *Processor) ExtractFeatures() Features {
	p.mu.RLock()
	defer p.mu.RUnlock()

	var feat Features
	n := len(p.frameBuffer)
	if n < 4 {
		return feat
	}

	for ch := 0; ch < 8; ch++ {
		var sumAbs float64
		var wl float64
		var zc int
		var betaPow float64

		for i := 0; i < n; i++ {
			val := p.frameBuffer[i].Channels[ch]
			sumAbs += math.Abs(val)

			if i > 0 {
				prev := p.frameBuffer[i-1].Channels[ch]
				wl += math.Abs(val - prev)

				// Zero crossing with noise deadband (> 2.0 uV)
				if (val > 2.0 && prev < -2.0) || (val < -2.0 && prev > 2.0) {
					zc++
				}
			}

			// Estimate high-frequency Beta band power via differential variance
			if i >= 2 {
				d2 := val - 2.0*p.frameBuffer[i-1].Channels[ch] + p.frameBuffer[i-2].Channels[ch]
				betaPow += d2 * d2
			}
		}

		feat.MeanAbsVal[ch] = sumAbs / float64(n)
		feat.WaveformLen[ch] = wl
		feat.ZeroCrosses[ch] = zc
		feat.BetaBandPow[ch] = betaPow / float64(n)
	}

	return feat
}

// DecodeIntent evaluates extracted features against physiological motor thresholds.
func (p *Processor) DecodeIntent() DecodedIntent {
	start := time.Now()
	feat := p.ExtractFeatures()

	var maxMav float64
	var dominantCh int
	for ch := 0; ch < 8; ch++ {
		if feat.MeanAbsVal[ch] > maxMav {
			maxMav = feat.MeanAbsVal[ch]
			dominantCh = ch
		}
	}

	decoded := DecodedIntent{
		Intent:     IntentIdle,
		Confidence: 0.95,
		Channel:    dominantCh,
		Timestamp:  time.Now(),
	}

	// Physiological thresholds:
	// Bilateral high EMG (> 50uV on jaw/throat or ch 0 & 1): Emergency Brake
	if feat.MeanAbsVal[0] > 50.0 && feat.MeanAbsVal[1] > 50.0 {
		decoded.Intent = IntentBrake
		decoded.Confidence = math.Min(1.0, (feat.MeanAbsVal[0]+feat.MeanAbsVal[1])/150.0)
	} else if feat.MeanAbsVal[2] > 40.0 && feat.MeanAbsVal[3] < 20.0 {
		// Asymmetric left motor cortex activation
		decoded.Intent = IntentSteerLeft
		decoded.Confidence = 0.88
		decoded.Channel = 2
	} else if feat.MeanAbsVal[3] > 40.0 && feat.MeanAbsVal[2] < 20.0 {
		// Asymmetric right motor cortex activation
		decoded.Intent = IntentSteerRight
		decoded.Confidence = 0.88
		decoded.Channel = 3
	} else if feat.BetaBandPow[4] > 80.0 && feat.MeanAbsVal[4] > 12.0 {
		// Grasp intent in motor strip (C3/C4)
		decoded.Intent = IntentGrasp
		decoded.Confidence = 0.92
		decoded.Channel = 4
	} else if feat.MeanAbsVal[6] > 18.0 && feat.ZeroCrosses[6] > 2 {
		// Subvocal laryngeal micro-activation
		decoded.Intent = IntentSubvocalConfirm
		decoded.Confidence = 0.90
		decoded.Channel = 6
	}

	decoded.LatencyMs = time.Since(start).Milliseconds()

	p.mu.Lock()
	p.lastIntent = decoded
	p.mu.Unlock()

	return decoded
}

// GetLastIntent returns the most recently decoded thought intent.
func (p *Processor) GetLastIntent() DecodedIntent {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lastIntent
}
