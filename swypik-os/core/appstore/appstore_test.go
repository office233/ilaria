package appstore

import (
	"testing"
)

func catalogFixture(t *testing.T) *Store {
	t.Helper()
	s := NewStore()
	if err := s.RegisterCatalogEntry(AppPackage{ID: "test.application", Name: "Caller catalog entry",
		Version: "test", Platform: "desktop"}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAppStore(t *testing.T) {
	store := catalogFixture(t)
	apps := store.ListApps()
	if len(apps) != 1 {
		t.Fatalf("expected one explicitly configured entry, got %d", len(apps))
	}

	// Catalog presence must never be confused with a real installation.
	app, err := store.InstallApp("test.application")
	if err == nil || app == nil || app.Installed {
		t.Fatalf("unimplemented install reported success: app=%+v err=%v", app, err)
	}

	// Test AI On-Demand Generation
	custom := store.GenerateOnDemand("Auto Invoicer", "Creates smart fiscal receipts via voice", "Finance")
	if custom.Name != "Auto Invoicer" || !custom.AIDriven || custom.Installed || custom.Version != "draft" || custom.SizeMB != 0 {
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
