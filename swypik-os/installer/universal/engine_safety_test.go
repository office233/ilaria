package universal_test

import (
	"context"
	"strings"
	"testing"

	"swypik-os/installer/universal"
)

func TestGenerateAdaptationPlanNilUsesPCDefaults(t *testing.T) {
	plan := universal.NewInstallerEngine(nil, nil).GenerateAdaptationPlan(nil)
	if plan.TargetProfile != "SwypikOS-Desktop-SpatialLuxury" {
		t.Fatalf("target profile=%q", plan.TargetProfile)
	}
}

func TestDeployRejectsNilInputs(t *testing.T) {
	engine := universal.NewInstallerEngine(nil, nil)
	if err := engine.Deploy(context.Background(), t.TempDir(), nil, &universal.AdaptationPlan{}); err == nil || !strings.Contains(err.Error(), "target environment") {
		t.Fatalf("nil environment error=%v", err)
	}
	if err := engine.Deploy(context.Background(), t.TempDir(), &universal.TargetEnvironment{}, nil); err == nil || !strings.Contains(err.Error(), "adaptation plan") {
		t.Fatalf("nil plan error=%v", err)
	}
}
