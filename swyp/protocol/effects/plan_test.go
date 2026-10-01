package effects

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func fixturePlan() EffectPlan {
	return EffectPlan{Version, strings.Repeat("0", 64), "main", []string{"clock.read", "fs.read"}, map[string]string{"main/clock.read": "clock_read", "load/fs.read": "workspace_read"}}
}

func TestPlanCanonicalRoundTripAndConservativeDeclarations(t *testing.T) {
	plan := fixturePlan()
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodePlan(data)
	if err != nil || !reflect.DeepEqual(decoded, plan) {
		t.Fatalf("decoded=%+v err=%v", decoded, err)
	}
	plan.CapabilityBindings = map[string]string{"load/fs.read": "workspace_read", "main/clock.read": "clock_read"}
	again, _ := json.Marshal(plan)
	if !bytes.Equal(data, again) {
		t.Fatal("map insertion order changed canonical plan JSON")
	}
	for _, effects := range [][]string{{}, {"clock.read"}, {"fs.read"}, {"clock.read", "fs.read"}} {
		plan.Effects = effects
		plan.CapabilityBindings = map[string]string{}
		encoded, _ := json.Marshal(plan)
		if _, err := DecodePlan(encoded); err != nil {
			t.Fatalf("conservative declaration %v: %v", effects, err)
		}
	}
}

func TestValidatePlanRefusesInvalidWireIdentitiesEffectsAndBindings(t *testing.T) {
	for name, mutate := range map[string]func(*EffectPlan){
		"version":           func(p *EffectPlan) { p.ProtocolVersion++ },
		"uppercase hash":    func(p *EffectPlan) { p.ModuleHash = strings.Repeat("A", 64) },
		"short hash":        func(p *EffectPlan) { p.ModuleHash = "a" },
		"long entry":        func(p *EffectPlan) { p.Entry = strings.Repeat("a", 65) },
		"entry slash":       func(p *EffectPlan) { p.Entry = "main/other" },
		"entry unicode":     func(p *EffectPlan) { p.Entry = "māin" },
		"entry digit":       func(p *EffectPlan) { p.Entry = "1main" },
		"null effects":      func(p *EffectPlan) { p.Effects = nil },
		"null bindings":     func(p *EffectPlan) { p.CapabilityBindings = nil },
		"duplicate effects": func(p *EffectPlan) { p.Effects = []string{"clock.read", "clock.read"} },
		"unordered effects": func(p *EffectPlan) { p.Effects = []string{"fs.read", "clock.read"} },
		"unsupported":       func(p *EffectPlan) { p.Effects = []string{"rng.sample"} },
		"undeclared":        func(p *EffectPlan) { p.Effects = []string{"clock.read"} },
		"missing function":  func(p *EffectPlan) { p.CapabilityBindings["/clock.read"] = "clock_read" },
		"missing effect":    func(p *EffectPlan) { p.CapabilityBindings["main/"] = "clock_read" },
		"extra slash":       func(p *EffectPlan) { p.CapabilityBindings["main/clock.read/extra"] = "clock_read" },
		"binding function":  func(p *EffectPlan) { p.CapabilityBindings[strings.Repeat("a", 65)+"/clock.read"] = "clock_read" },
		"capability token":  func(p *EffectPlan) { p.CapabilityBindings["main/clock.read"] = "cap://secret" },
		"long capability":   func(p *EffectPlan) { p.CapabilityBindings["main/clock.read"] = strings.Repeat("a", 65) },
		"excessive map": func(p *EffectPlan) {
			p.CapabilityBindings = make(map[string]string)
			for i := 0; i <= MaxPlanBindings; i++ {
				p.CapabilityBindings[fmt.Sprintf("f%d/clock.read", i)] = "clock_read"
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			plan := fixturePlan()
			mutate(&plan)
			if err := ValidatePlan(plan); err == nil {
				t.Fatal("invalid plan accepted")
			}
		})
	}
}

func TestDecodePlanRefusesAmbiguousNestedMapsAndMalformedEnvelopes(t *testing.T) {
	good, _ := json.Marshal(fixturePlan())
	for name, data := range map[string][]byte{
		"duplicate field": bytes.Replace(good, []byte(`"entry":"main"`), []byte(`"entry":"main","entry":"other"`), 1),
		"alias field":     bytes.Replace(good, []byte(`"entry"`), []byte(`"ENTRY"`), 1),
		"missing":         bytes.Replace(good, []byte(`"entry":"main",`), nil, 1),
		"unknown":         bytes.Replace(good, []byte(`"entry":"main"`), []byte(`"entry":"main","grant":"forged"`), 1),
		"null map":        bytes.Replace(good, []byte(`{"load/fs.read":"workspace_read","main/clock.read":"clock_read"}`), []byte(`null`), 1),
		"map array":       bytes.Replace(good, []byte(`{"load/fs.read":"workspace_read","main/clock.read":"clock_read"}`), []byte(`[]`), 1),
		"null effects":    bytes.Replace(good, []byte(`["clock.read","fs.read"]`), []byte(`null`), 1),
		"nested duplicate": bytes.Replace(good, []byte(`"main/clock.read":"clock_read"`),
			[]byte(`"main/clock.read":"clock_read","main/clock.read":"other_clock"`), 1),
		"escaped duplicate": bytes.Replace(good, []byte(`"main/clock.read":"clock_read"`),
			[]byte(`"main/clock.read":"clock_read","main/\u0063lock.read":"other_clock"`), 1),
		"nested null":    bytes.Replace(good, []byte(`"main/clock.read":"clock_read"`), []byte(`"main/clock.read":null`), 1),
		"nested number":  bytes.Replace(good, []byte(`"main/clock.read":"clock_read"`), []byte(`"main/clock.read":1`), 1),
		"surrogate":      bytes.Replace(good, []byte(`"entry":"main"`), []byte(`"entry":"\ud800"`), 1),
		"trailing":       append(append([]byte{}, good...), []byte(` {}`)...),
		"invalid utf8":   append(append([]byte{}, good...), 0xff),
		"message budget": bytes.Repeat([]byte(" "), MaxMessageBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodePlan(data); err == nil {
				t.Fatal("malformed plan accepted")
			}
		})
	}
}
