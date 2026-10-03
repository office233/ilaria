package supervisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swypik-os/core/controlkernel"
)

func TestInspectReturnsOwnedTerminalStatusWithoutSourceOrRoots(t *testing.T) {
	f := newFixture(t)
	f.start()
	f.handle(1, "fs.read")
	want, err := f.sup.Finish(context.Background(), strings.Repeat("1", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.sup.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.reader.Close(); err != nil {
		t.Fatal(err)
	}
	root := f.config.RootPaths["fixture"]
	if err := os.Remove(filepath.Join(root, "input.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	got, err := Inspect(f.kernel, f.config.LedgerPath, f.config.Plan.TaskID, f.config.Plan.RunID)
	if err != nil || got != want || f.reads != 1 || f.verifies != 1 {
		t.Fatalf("inspection got=%+v want=%+v err=%v", got, want, err)
	}
	for _, ids := range [][2]string{{"other", "run"}, {"task", "other"}} {
		if _, err := Inspect(f.kernel, f.config.LedgerPath, ids[0], ids[1]); err == nil {
			t.Fatal("inspection accepted different task/run identity")
		}
	}
}

func TestInspectMissingOrUnownedLedgerFailsWithoutCreation(t *testing.T) {
	f := newFixture(t)
	if _, err := Inspect(f.kernel, f.config.LedgerPath, "task", "run"); !os.IsNotExist(err) {
		t.Fatalf("missing ledger err=%v", err)
	}
	if _, err := os.Stat(f.config.LedgerPath); !os.IsNotExist(err) {
		t.Fatalf("inspection created missing ledger: %v", err)
	}
	f.open()
	if err := f.sup.Close(); err != nil {
		t.Fatal(err)
	}
	other, err := controlkernel.OpenKernel(filepath.Join(t.TempDir(), "other.journal"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := Inspect(other, f.config.LedgerPath, "task", "run"); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("unowned ledger err=%v", err)
	}
	if _, err := other.CreateTask(controlkernel.Task{ID: "task", Goal: "different owner"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(other, f.config.LedgerPath, "task", "run"); !errors.Is(err, ErrPolicyChanged) {
		t.Fatalf("different ownership metadata err=%v", err)
	}
}

func TestInspectRejectsEmptyAndTornLedgerWithoutRepair(t *testing.T) {
	for _, damage := range []string{"empty", "torn"} {
		t.Run(damage, func(t *testing.T) {
			f := newFixture(t)
			f.start()
			if err := f.sup.Close(); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(f.config.LedgerPath)
			if err != nil {
				t.Fatal(err)
			}
			if damage == "empty" {
				raw = nil
			} else {
				raw = append(raw, []byte("CK")...)
			}
			if err := os.WriteFile(f.config.LedgerPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Inspect(f.kernel, f.config.LedgerPath, "task", "run"); !errors.Is(err, controlkernel.ErrCorruptJournal) {
				t.Fatalf("inspection accepted damaged ledger: %v", err)
			}
			after, err := os.ReadFile(f.config.LedgerPath)
			if err != nil || string(after) != string(raw) {
				t.Fatalf("inspection repaired damaged ledger: %v", err)
			}
		})
	}
}
