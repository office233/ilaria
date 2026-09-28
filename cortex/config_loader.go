package cortex

// config_loader.go — încărcare Config dintr-un fișier JSON extern.
//
// Modelul de merge:
//   1. Pornește de la DefaultConfig() (toate câmpurile setate la valorile
//      "sănătoase" canonical).
//   2. Aplică unmarshal JSON peste această structură. json.Unmarshal
//      lasă câmpurile absente din JSON neschimbate, deci utilizatorul
//      poate suprascrie selectiv doar câmpurile care îl interesează.
//   3. Rulează Validate() pe rezultat.
//
// Acest fișier este intenționat liber de orice dependență externă, ca
// să poată fi importat din orice cmd/* fără a polua go.mod.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// DefaultConfigPaths returnează căile căutate implicit de ResolveConfigPath
// când utilizatorul nu pasează un path explicit. Ordinea contează:
// prima cale existentă câștigă.
//
// Convenția: fișierul de config trăiește în directorul curent de lucru
// (lângă binarul / scriptul lansat) și se numește "ilaria.json"
// sau, ca alternativă, "config.json". Această convenție este suficient
// de strictă pentru reproducibilitate și suficient de permisivă pentru
// experimente locale.
func DefaultConfigPaths() []string {
	return []string{
		"ilaria.json",
		"config.json",
	}
}

// ConfigEnvVar este numele variabilei de mediu care poate înlocui căile
// implicite. Setarea ei la calea unui fișier JSON forțează LoadConfig să
// folosească acel fișier (echivalent cu -config <path>).
const ConfigEnvVar = "ILARIA_CONFIG"

// ResolveConfigPath decide ce path de config se folosește. Precedența:
//
//  1. explicitPath, dacă e nevid (flag -config de la CLI);
//  2. $ILARIA_CONFIG, dacă e setată și nevidă;
//  3. prima cale din DefaultConfigPaths() care există pe disk;
//  4. "" (string gol) — indicând că nu există config extern și se va
//     folosi DefaultConfig() neschimbat.
//
// Returnează și o sursă lizibilă (pentru log-uri), nu doar path-ul.
func ResolveConfigPath(explicitPath string) (path, source string) {
	if explicitPath != "" {
		return explicitPath, "flag"
	}
	if env := os.Getenv(ConfigEnvVar); env != "" {
		return env, "env"
	}
	for _, candidate := range DefaultConfigPaths() {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, "auto"
		}
	}
	return "", ""
}

// LoadConfig încarcă un Config dintr-un fișier JSON, merge-uindu-l peste
// DefaultConfig().
//
// Dacă path este "", returnează DefaultConfig() fără să atingă disk-ul.
// Dacă path nu există, returnează eroare (nu fallback silent — operatorul
// a cerut explicit un fișier, e nesigur să-l ignorăm).
//
// Apelantul tipic:
//
//	cfg, source, err := cortex.LoadConfig(*configFlag)
//	if err != nil { log.Fatal(err) }
//	if source != "" { log.Printf("config loaded from %s", source) }
//
// Pentru cazul "vreau să încerc fișiere implicite, dar nu mă supăr dacă
// lipsesc", folosește MustLoadConfigWithDefaults.
func LoadConfig(path string) (Config, error) {
	cfg := DefaultConfig()
	if path == "" {
		return cfg, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("load config %s: %w", path, err)
	}
	if len(raw) == 0 {
		return cfg, fmt.Errorf("load config %s: file is empty", path)
	}
	// Unmarshal direct: câmpurile absente din JSON rămân la valoarea din
	// DefaultConfig (merge implicit). DisallowUnknownFields ar fi mai
	// strict, dar penalizează compatibilitatea înainte/înapoi între
	// versiuni — preferăm Validate() ca gardian semantic.
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config %s: %w", path, err)
	}
	if err := cfg.Validate(); err != nil {
		return cfg, fmt.Errorf("validate config %s: %w", path, err)
	}
	return cfg, nil
}

// MustLoadConfigWithDefaults este variantă cooperantă: dacă explicitPath
// e gol și niciun fișier implicit nu există, returnează DefaultConfig()
// fără eroare. Dacă fișierul există dar e invalid, returnează eroare.
//
// Folosit pentru cmd/* care vor "best-effort" — config dacă există,
// altfel defaults.
func MustLoadConfigWithDefaults(explicitPath string) (cfg Config, sourcePath string, err error) {
	path, _ := ResolveConfigPath(explicitPath)
	cfg, err = LoadConfig(path)
	return cfg, path, err
}

// SaveConfig serializează un Config la disk ca JSON indentat. Util
// pentru -config-print (operatorul vrea un template).
//
// Permisiuni: 0o600 ca să se alinieze cu doctrina de securitate
// documentată în HARDCODING_AND_LIMITATIONS.md (fișiere de stare strict
// readable de owner). Directorul părinte e creat cu 0o700 dacă lipsește.
func SaveConfig(path string, cfg Config) error {
	if path == "" {
		return errors.New("save config: empty path")
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write config %s: %w", path, err)
	}
	return nil
}
