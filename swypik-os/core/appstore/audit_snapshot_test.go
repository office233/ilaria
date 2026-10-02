package appstore

import "testing"

func TestCatalogSnapshotsCannotForgeInstallation(t *testing.T) {
	s := catalogFixture(t)
	apps := s.ListApps()
	id := apps[0].ID
	apps[0].Installed = true
	apps[0].Name = "mutated"
	app, err := s.InstallApp(id)
	if err == nil || app.Installed || app.Name == "mutated" {
		t.Fatalf("list result exposes catalog state: %+v %v", app, err)
	}
	app.Installed = true
	app, _ = s.InstallApp(id)
	if app.Installed {
		t.Fatal("install refusal exposes catalog state")
	}
	custom := s.GenerateOnDemand("Caller draft", "Description", "Test")
	custom.Installed = true
	custom.Name = "mutated"
	stored, _ := s.InstallApp(custom.ID)
	if stored.Installed || stored.Name != "Caller draft" {
		t.Fatal("draft result exposes catalog state")
	}
	ordered := s.ListApps()
	for i, app := range ordered {
		if i > 0 && app.ID < ordered[i-1].ID {
			t.Fatal("catalog order is nondeterministic")
		}
	}
}

func TestCatalogHasNoFictitiousDefaultsOrImplicitOverwrite(t *testing.T) {
	s := NewStore()
	if len(s.ListApps()) != 0 {
		t.Fatal("new store invented package versions, sizes or capabilities")
	}
	entry := AppPackage{ID: "configured", Name: "Caller entry"}
	if err := s.RegisterCatalogEntry(entry); err != nil {
		t.Fatal(err)
	}
	entry.Name = "overwrite"
	if err := s.RegisterCatalogEntry(entry); err == nil {
		t.Fatal("duplicate catalog registration overwrote metadata")
	}
	entry.ID, entry.Installed = "forged", true
	if err := s.RegisterCatalogEntry(entry); err == nil {
		t.Fatal("metadata registration forged installed state")
	}
	first := s.GenerateOnDemand("Draft", "first", "Test")
	second := s.GenerateOnDemand(" Draft ", "overwrite", "Test")
	if first.ID != second.ID || second.Description != "first" {
		t.Fatal("repeated generation overwrote an existing draft")
	}
}
