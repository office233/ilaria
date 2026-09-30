package appstore

import (
	"testing"
)

func TestAppStore(t *testing.T) {
	store := NewStore()
	apps := store.ListApps()
	if len(apps) < 5 {
		t.Fatalf("expected at least 5 default apps, got %d", len(apps))
	}

	// Test installing uninstalled app
	installed, err := store.InstallApp("app.connect.mesh")
	if err != nil {
		t.Fatalf("failed to install app: %v", err)
	}
	if !installed.Installed {
		t.Errorf("expected app to be marked installed")
	}

	// Test AI On-Demand Generation
	custom := store.GenerateOnDemand("Auto Invoicer", "Creates smart fiscal receipts via voice", "Finance")
	if custom.Name != "Auto Invoicer" || !custom.AIDriven {
		t.Errorf("custom AI app invalid: %+v", custom)
	}
}

func TestGeneratedAppCatalogIsBounded(t *testing.T) {
	store := NewStore()
	store.maxApps = len(store.apps) + 1
	if got := store.GenerateOnDemand("One", "first", "Test"); got == nil {
		t.Fatal("first generated app rejected")
	}
	if got := store.GenerateOnDemand("Two", "second", "Test"); got != nil {
		t.Fatalf("catalog exceeded cap: %+v", got)
	}
}
