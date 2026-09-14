// cortex-broca-train — professional trainer for Broca 2.0 (MiniTransformer).
//
// Improvements over the previous version:
//   - Full backprop training via TrainStepAdam (the old code path only
//     updated embeddings + perturbed block weights with noise, so it
//     could never converge).
//   - Adam optimizer with bias correction and gradient clipping.
//   - Linear warmup + cosine decay learning-rate schedule.
//   - Multi-corpus input: pass a comma-separated list of JSONL files.
//   - Train/eval split (last EvalLines lines of each file are held out).
//   - Per-checkpoint validation loss on the held-out split with early
//     stopping when the running average stops improving.
//   - TSV log (training.log) with step, lr, train_loss, val_loss so the
//     loss curve can be inspected after the run.
//   - Resumable: if a previous run wrote training.log, the next call
//     skips that many SGD steps so the LR schedule continues smoothly.
//
// Example:
//
//	cortex-broca-train -data-dir ./data/cortex-auto \
//	    -corpus ./data/corpus/dolly.jsonl,./data/corpus/alpaca.jsonl \
//	    -peak-lr 0.001 -warmup 200 -total-steps 20000 \
//	    -eval-every 500 -checkpoint-every 1000
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"nexus-cortex/cortex"
	"nexus-cortex/cortex/compute"
)

type trainConfig struct {
	dataDir           string
	corpora           []string
	peakLR            float64
	minLR             float64
	warmupSteps       int
	totalSteps        int
	maxSeqLen         int
	batchSize         int
	weightDecay       float64
	dropout           float64
	orgConfigPath     string
	evalLines         int
	evalEvery         int
	checkpointEvery   int
	earlyStopPatience int
	seed              int64
	logPath           string
	optimizerPath     string

	// Auto-eval hook: dacă autoEval=true, după fiecare new-best
	// checkpoint se lansează `broca-eval` ca subprocess CPU-only și
	// rezultatul (overall accuracy + per-category) e append-uit la
	// evalHistoryPath ca JSONL. Permite trasarea curbei
	// loss-vs-accuracy în timp ce training-ul rulează (vezi §X
	// din docs/HARDCODING_AND_LIMITATIONS.md).
	autoEval           bool
	autoEvalBin        string // path la broca-eval[.exe] — auto-detect dacă vid
	autoEvalCoT        bool   // forțează --cot în subprocess (mai lent, mai precis)
	autoEvalCoTSamples int
	autoEvalTemp       float64
	autoEvalTopK       int
	autoEvalMaxTokens  int
	evalHistoryPath    string // JSONL: o linie per eval rulat
}

// fileConfig este versiunea on-disk a trainConfig — câmpurile sunt
// puncteri ca să distingem "nesetat în JSON" de "setat la zero".
// Doar câmpurile prezente în JSON suprascriu default-urile de flag.
type fileConfig struct {
	DataDir            *string  `json:"data_dir,omitempty"`
	Corpus             *string  `json:"corpus,omitempty"`
	PeakLR             *float64 `json:"peak_lr,omitempty"`
	MinLR              *float64 `json:"min_lr,omitempty"`
	Warmup             *int     `json:"warmup,omitempty"`
	TotalSteps         *int     `json:"total_steps,omitempty"`
	MaxSeqLen          *int     `json:"max_seq_len,omitempty"`
	BatchSize          *int     `json:"batch_size,omitempty"`
	WeightDecay        *float64 `json:"weight_decay,omitempty"`
	Dropout            *float64 `json:"dropout,omitempty"`
	EvalLines          *int     `json:"eval_lines,omitempty"`
	EvalEvery          *int     `json:"eval_every,omitempty"`
	CheckpointEvery    *int     `json:"checkpoint_every,omitempty"`
	EarlyStop          *int     `json:"early_stop,omitempty"`
	Seed               *int64   `json:"seed,omitempty"`
	Log                *string  `json:"log,omitempty"`
	OptimizerState     *string  `json:"optimizer_state,omitempty"`
	AutoEval           *bool    `json:"auto_eval,omitempty"`
	AutoEvalBin        *string  `json:"auto_eval_bin,omitempty"`
	AutoEvalCoT        *bool    `json:"auto_eval_cot,omitempty"`
	AutoEvalCoTSamples *int     `json:"auto_eval_cot_samples,omitempty"`
	AutoEvalTemp       *float64 `json:"auto_eval_temp,omitempty"`
	AutoEvalTopK       *int     `json:"auto_eval_top_k,omitempty"`
	AutoEvalMaxTokens  *int     `json:"auto_eval_max_tokens,omitempty"`
	EvalHistory        *string  `json:"eval_history,omitempty"`
}

func main() {
	// -config se rezolvă ÎNAINTE de flag.Parse: dacă e furnizat, valorile
	// din JSON înlocuiesc default-urile flag-urilor. Flag-urile CLI au
	// apoi prioritate finală (override peste JSON). Aceasta este pattern-ul
	// standard "config + override" — nu requireste detectarea explicită
	// "a fost flag-ul setat?" care nu e suportată direct de pkg flag.
	configPath := ""
	for i, arg := range os.Args[1:] {
		if arg == "-config" || arg == "--config" {
			if i+2 < len(os.Args) {
				configPath = os.Args[i+2]
			}
		} else if strings.HasPrefix(arg, "-config=") {
			configPath = strings.TrimPrefix(arg, "-config=")
		} else if strings.HasPrefix(arg, "--config=") {
			configPath = strings.TrimPrefix(arg, "--config=")
		}
	}
	fileCfg := fileConfig{}
	if configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			log.Fatalf("read -config %s: %v", configPath, err)
		}
		if err := json.Unmarshal(data, &fileCfg); err != nil {
			log.Fatalf("parse -config %s: %v", configPath, err)
		}
		fmt.Printf("[config] loaded defaults from %s\n", configPath)
	}

	// Default-urile flag-urilor sunt suprascrise de JSON (dacă există).
	def := func(s *string, fallback string) string {
		if s != nil {
			return *s
		}
		return fallback
	}
	defF := func(s *float64, fallback float64) float64 {
		if s != nil {
			return *s
		}
		return fallback
	}
	defI := func(s *int, fallback int) int {
		if s != nil {
			return *s
		}
		return fallback
	}
	defI64 := func(s *int64, fallback int64) int64 {
		if s != nil {
			return *s
		}
		return fallback
	}
	defB := func(s *bool, fallback bool) bool {
		if s != nil {
			return *s
		}
		return fallback
	}

	_ = flag.String("config", "", "Path to JSON config file; flag values override config values")
	dataDir := flag.String("data-dir", def(fileCfg.DataDir, "./data/cortex-auto"), "Organism data directory")
	corpus := flag.String("corpus", def(fileCfg.Corpus, "./data/corpus/dolly.jsonl"), "Corpus JSONL file(s), comma-separated")
	peakLR := flag.Float64("peak-lr", defF(fileCfg.PeakLR, 1e-3), "Peak learning rate (after warmup)")
	minLR := flag.Float64("min-lr", defF(fileCfg.MinLR, 1e-5), "Final learning rate (after decay)")
	warmup := flag.Int("warmup", defI(fileCfg.Warmup, 200), "Linear warmup steps")
	totalSteps := flag.Int("total-steps", defI(fileCfg.TotalSteps, 5000), "Total training steps (incl. warmup)")
	maxSeqLen := flag.Int("max-seq-len", defI(fileCfg.MaxSeqLen, 0), "Truncate sequences to this many tokens (0 = use transformer config)")
	batchSize := flag.Int("batch-size", defI(fileCfg.BatchSize, 8), "Sequences accumulated per optimizer step, mean weighted per TOKEN (1 = legacy single-sample)")
	weightDecay := flag.Float64("weight-decay", defF(fileCfg.WeightDecay, 0.01), "AdamW decoupled weight decay on weight matrices (0 = plain Adam)")
	dropout := flag.Float64("dropout", defF(fileCfg.Dropout, 0.1), "Training-time dropout on attention weights + FFN activations (0 = off)")
	orgConfig := flag.String("org-config", "", "cortex Config JSON (architecture: embed dim/layers/RoPE/SwiGLU etc.). Empty = env/auto-discovery/defaults")
	evalLines := flag.Int("eval-lines", defI(fileCfg.EvalLines, 200), "Per-corpus lines held out for validation")
	evalEvery := flag.Int("eval-every", defI(fileCfg.EvalEvery, 250), "Run validation every N training steps")
	checkpointEvery := flag.Int("checkpoint-every", defI(fileCfg.CheckpointEvery, 1000), "Save transformer every N steps (0 = only at end)")
	earlyStopPatience := flag.Int("early-stop", defI(fileCfg.EarlyStop, 5), "Stop if val loss hasn't improved for N consecutive evals (0 = never)")
	seed := flag.Int64("seed", defI64(fileCfg.Seed, 42), "RNG seed")
	logPath := flag.String("log", def(fileCfg.Log, ""), "TSV log path (default: <data-dir>/training.log)")
	optimizerPath := flag.String("optimizer-state", def(fileCfg.OptimizerState, ""), "Adam state file (default: <data-dir>/optimizer.nxto)")

	autoEval := flag.Bool("auto-eval", defB(fileCfg.AutoEval, false), "After every new-best checkpoint, spawn broca-eval (CPU-only) and append result to eval-history.jsonl")
	autoEvalBin := flag.String("auto-eval-bin", def(fileCfg.AutoEvalBin, ""), "Path to broca-eval[.exe] binary (default: auto-detect next to trainer)")
	autoEvalCoT := flag.Bool("auto-eval-cot", defB(fileCfg.AutoEvalCoT, false), "Pass --cot to broca-eval (slower but higher-accuracy scoring)")
	autoEvalCoTSamples := flag.Int("auto-eval-cot-samples", defI(fileCfg.AutoEvalCoTSamples, 3), "Number of CoT votes when --auto-eval-cot is set")
	autoEvalTemp := flag.Float64("auto-eval-temp", defF(fileCfg.AutoEvalTemp, 0.6), "Sampling temperature for auto-eval subprocess")
	autoEvalTopK := flag.Int("auto-eval-top-k", defI(fileCfg.AutoEvalTopK, 40), "Top-k cutoff for auto-eval subprocess")
	autoEvalMaxTokens := flag.Int("auto-eval-max-tokens", defI(fileCfg.AutoEvalMaxTokens, 40), "Max generated tokens per auto-eval task")
	evalHistoryPath := flag.String("eval-history", def(fileCfg.EvalHistory, ""), "Auto-eval history JSONL path (default: <data-dir>/eval-history.jsonl)")

	flag.Parse()

	cfg := trainConfig{
		dataDir:            *dataDir,
		corpora:            splitAndTrim(*corpus),
		peakLR:             *peakLR,
		minLR:              *minLR,
		warmupSteps:        *warmup,
		totalSteps:         *totalSteps,
		maxSeqLen:          *maxSeqLen,
		batchSize:          *batchSize,
		weightDecay:        *weightDecay,
		dropout:            *dropout,
		orgConfigPath:      *orgConfig,
		evalLines:          *evalLines,
		evalEvery:          *evalEvery,
		checkpointEvery:    *checkpointEvery,
		earlyStopPatience:  *earlyStopPatience,
		seed:               *seed,
		logPath:            *logPath,
		optimizerPath:      *optimizerPath,
		autoEval:           *autoEval,
		autoEvalBin:        *autoEvalBin,
		autoEvalCoT:        *autoEvalCoT,
		autoEvalCoTSamples: *autoEvalCoTSamples,
		autoEvalTemp:       *autoEvalTemp,
		autoEvalTopK:       *autoEvalTopK,
		autoEvalMaxTokens:  *autoEvalMaxTokens,
		evalHistoryPath:    *evalHistoryPath,
	}
	if cfg.logPath == "" {
		cfg.logPath = filepath.Join(cfg.dataDir, "training.log")
	}
	if cfg.optimizerPath == "" {
		cfg.optimizerPath = filepath.Join(cfg.dataDir, "optimizer.nxto")
	}
	if cfg.evalHistoryPath == "" {
		cfg.evalHistoryPath = filepath.Join(cfg.dataDir, "eval-history.jsonl")
	}
	if cfg.batchSize < 1 {
		cfg.batchSize = 1
	}

	for _, c := range cfg.corpora {
		if _, err := os.Stat(c); err != nil {
			log.Fatalf("corpus not found: %s (%v)", c, err)
		}
	}

	if err := run(cfg); err != nil {
		log.Fatalf("training failed: %v", err)
	}
}

func splitAndTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// autoEvalRequest e payload-ul trimis pe canalul către worker-ul de
// auto-eval. Worker-ul rulează broca-eval ca subprocess CPU-only,
// citește raportul JSON, și append-ează o linie compactă în JSONL.
type autoEvalRequest struct {
	step    int
	valLoss float32
	// modelPath e calea checkpoint-ului "best" la momentul declanșării
	// (transformer.best.nxtf). Worker-ul îi pasează --model <abs-path>
	// ca să nu existe race cu următorul checkpoint care suprascrie
	// transformer.nxtf.
	modelPath string
}

// autoEvalRecord e linia JSONL scrisă în eval-history.jsonl. Câmpurile
// sunt explicit minimale: step, val_loss, accuracy + per-category. Cine
// vrea detalii per-task se uită în reportul plin din evals/.
type autoEvalRecord struct {
	Timestamp   string             `json:"timestamp"`
	Step        int                `json:"step"`
	ValLoss     float32            `json:"val_loss"`
	ModelPath   string             `json:"model_path"`
	ReportPath  string             `json:"report_path"`
	OverallAcc  float64            `json:"overall_accuracy"`
	OverallN    int                `json:"overall_total"`
	OverallOK   int                `json:"overall_correct"`
	PerCategory map[string]float64 `json:"per_category_accuracy"`
	WallSecs    float64            `json:"wall_secs"`
	Error       string             `json:"error,omitempty"`
}

// resolveAutoEvalBin returnează calea către broca-eval[.exe].
// Default: lângă binarul cortex-broca-train. Permite override prin flag.
func resolveAutoEvalBin(explicit string) (string, error) {
	if explicit != "" {
		if _, err := os.Stat(explicit); err != nil {
			return "", fmt.Errorf("auto-eval-bin %s: %w", explicit, err)
		}
		return explicit, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	dir := filepath.Dir(self)
	candidates := []string{
		filepath.Join(dir, "broca-eval.exe"),
		filepath.Join(dir, "broca-eval"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
	}
	return "", fmt.Errorf("broca-eval not found in %s (tried %v); pass -auto-eval-bin", dir, candidates)
}

// startAutoEvalWorker pornește o goroutine care drenează canalul de
// request-uri și execută câte un broca-eval pe rând. Canalul are
// buffer 1: dacă vine un request și worker-ul e ocupat, request-ul nou
// înlocuiește pe cel din coadă (păstrăm doar pe ultimul checkpoint —
// dacă training-ul merge mai repede ca eval-ul, nu acumulăm backlog).
// Returnează (chanSend, closeFn). closeFn așteaptă worker-ul să termine.
func startAutoEvalWorker(cfg trainConfig, binPath string) (chan<- autoEvalRequest, func()) {
	ch := make(chan autoEvalRequest, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for req := range ch {
			rec := runAutoEval(cfg, binPath, req)
			if err := appendEvalHistory(cfg.evalHistoryPath, rec); err != nil {
				fmt.Printf("[auto-eval] WARNING: could not append history: %v\n", err)
			}
		}
	}()
	closeFn := func() {
		close(ch)
		<-done
	}
	return ch, closeFn
}

// sendAutoEval pune req în canal fără să blocheze. Dacă există deja
// un request în coadă (worker-ul e ocupat), îl înlocuim: doar
// rezultatul celui mai recent best-checkpoint contează.
func sendAutoEval(ch chan<- autoEvalRequest, req autoEvalRequest) {
	for {
		select {
		case ch <- req:
			return
		default:
			// Coada e plină — golim un slot. Folosim un cast trick:
			// citim de pe send-only nu se poate, deci sărim peste.
			// În practică, buffer-ul e 1, deci e suficient să încercăm
			// non-blocking send și dacă eșuează, log și abandon.
			fmt.Printf("[auto-eval] worker busy, dropping enqueue for step %d\n", req.step)
			return
		}
	}
}

// runAutoEval invocă broca-eval ca subprocess CPU-only și parsează
// raportul JSON rezultat. Erorile NU eșuează training-ul — întorc
// înregistrarea cu câmpul Error setat pentru audit.
func runAutoEval(cfg trainConfig, binPath string, req autoEvalRequest) autoEvalRecord {
	rec := autoEvalRecord{
		Timestamp: time.Now().Format(time.RFC3339),
		Step:      req.step,
		ValLoss:   req.valLoss,
		ModelPath: req.modelPath,
	}

	// Locația raportului — un fișier per step ca să nu se suprascrie.
	evalsDir := filepath.Join(cfg.dataDir, "evals")
	if err := os.MkdirAll(evalsDir, 0o755); err != nil {
		rec.Error = fmt.Sprintf("mkdir evals: %v", err)
		return rec
	}
	reportPath := filepath.Join(evalsDir, fmt.Sprintf("auto-step%07d.json", req.step))
	rec.ReportPath = reportPath

	args := []string{
		"--data-dir", cfg.dataDir,
		"--model", req.modelPath,
		"--out", reportPath,
		"--temp", fmt.Sprintf("%g", cfg.autoEvalTemp),
		"--top-k", fmt.Sprintf("%d", cfg.autoEvalTopK),
		"--max-tokens", fmt.Sprintf("%d", cfg.autoEvalMaxTokens),
	}
	if cfg.autoEvalCoT {
		args = append(args, "--cot", "--cot-samples", fmt.Sprintf("%d", cfg.autoEvalCoTSamples))
	}

	t0 := time.Now()
	fmt.Printf("[auto-eval] step %d → running %s (model=%s)\n",
		req.step, filepath.Base(binPath), filepath.Base(req.modelPath))

	out, runErr := runSubprocess(binPath, args)
	rec.WallSecs = time.Since(t0).Seconds()

	if runErr != nil {
		rec.Error = fmt.Sprintf("subprocess: %v | stderr-tail: %s",
			runErr, tailLines(out, 5))
		fmt.Printf("[auto-eval] ERROR (step %d): %s\n", req.step, rec.Error)
		return rec
	}

	// Parsare raport.
	data, err := os.ReadFile(reportPath)
	if err != nil {
		rec.Error = fmt.Sprintf("read report: %v", err)
		return rec
	}
	var report struct {
		Overall struct {
			Total    int     `json:"total"`
			Correct  int     `json:"correct"`
			Accuracy float64 `json:"accuracy"`
		} `json:"overall"`
		PerCategory []struct {
			Category string  `json:"category"`
			Accuracy float64 `json:"accuracy"`
		} `json:"per_category"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		rec.Error = fmt.Sprintf("parse report: %v", err)
		return rec
	}
	rec.OverallAcc = report.Overall.Accuracy
	rec.OverallN = report.Overall.Total
	rec.OverallOK = report.Overall.Correct
	rec.PerCategory = make(map[string]float64, len(report.PerCategory))
	for _, c := range report.PerCategory {
		rec.PerCategory[c.Category] = c.Accuracy
	}
	fmt.Printf("[auto-eval] step %d done in %.1fs — accuracy %.1f%% (%d/%d)\n",
		req.step, rec.WallSecs, 100*rec.OverallAcc, rec.OverallOK, rec.OverallN)
	return rec
}

// appendEvalHistory adaugă o linie JSON în fișierul JSONL.
// Crează fișierul dacă nu există. Sync după fiecare scriere pentru a
// supraviețui crash-urilor.
func appendEvalHistory(path string, rec autoEvalRecord) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

func run(cfg trainConfig) error {
	// Architecture config: -org-config flag > NEXUS_CORTEX_CONFIG env >
	// ./nexus-cortex.json auto-discovery > defaults. Until 2026-09 this
	// was hardwired to DefaultConfig(), which silently ignored any
	// architecture JSON — cursa E′'s RoPE/SwiGLU flags never arrived.
	orgCfgPath, orgCfgSource := cortex.ResolveConfigPath(cfg.orgConfigPath)
	orgCfg, err := cortex.LoadConfig(orgCfgPath)
	if err != nil {
		return fmt.Errorf("org config: %w", err)
	}
	if orgCfgPath != "" {
		fmt.Printf("[config] architecture from %s (%s)\n", orgCfgPath, orgCfgSource)
	}
	orgCfg.DataDir = cfg.dataDir
	orgCfg.Seed = cfg.seed
	orgCfg.Demo = false
	orgCfg.NoSave = false

	tokPath := filepath.Join(cfg.dataDir, "tokenizer.json")
	if _, err := os.Stat(tokPath); err != nil {
		return fmt.Errorf("tokenizer not found at %s — run cortex-tokenizer first", tokPath)
	}

	rng := rand.New(rand.NewSource(cfg.seed))

	// Try to grab a GPU. Tensor.MatMul auto-dispatches large matmuls to
	// cuBLAS when this succeeds; everything stays on CPU otherwise.
	if err := compute.InitCuBLAS(); err != nil {
		fmt.Printf("[cuBLAS] unavailable, staying on CPU: %v\n", err)
	} else {
		fmt.Println("[cuBLAS] GPU matmul active (cuBLAS handle ready on device 0)")
		defer compute.CloseCuBLAS()
	}

	fmt.Printf("Loading organism from %s ...\n", cfg.dataDir)
	org, err := cortex.LoadOrganism(orgCfg, rng)
	if err != nil || org == nil {
		// Fresh data dir (e.g. cursa E′): bootstrap a new organism and
		// persist it so every later tool (eval, probe, web) can load it.
		// Until 2026-09 this required manually running another cmd first.
		fmt.Printf("[bootstrap] LoadOrganism failed (%v) — creating a fresh organism in %s\n",
			err, cfg.dataDir)
		org = cortex.NewOrganism(orgCfg, rng)
		if org == nil {
			return fmt.Errorf("NewOrganism returned nil")
		}
		if serr := org.Save(cfg.dataDir); serr != nil {
			return fmt.Errorf("bootstrap save: %w", serr)
		}
	}
	if org.Tokenizer == nil {
		// A tokenizer.json placed in the data dir (trained separately via
		// cmd/cortex-tokenizer) is picked up here.
		tok, terr := cortex.LoadBPETokenizer(filepath.Join(cfg.dataDir, "tokenizer.json"))
		if terr != nil {
			return fmt.Errorf("organism has no BPE tokenizer and %s/tokenizer.json failed: %w",
				cfg.dataDir, terr)
		}
		org.Tokenizer = tok
		fmt.Printf("[bootstrap] tokenizer loaded from %s (vocab %d)\n",
			filepath.Join(cfg.dataDir, "tokenizer.json"), tok.ActualVocabSize())
	}

	if org.Transformer == nil {
		tfCfg := cortex.TransformerConfigFromConfig(org.Tokenizer.ActualVocabSize(), orgCfg)
		org.Transformer = cortex.NewMiniTransformer(tfCfg, rng)
		fmt.Printf("[Broca 2.0] Bootstrapped fresh transformer (%d params)\n",
			org.Transformer.ParamCount())
	}

	maxSeq := cfg.maxSeqLen
	if maxSeq <= 0 {
		maxSeq = org.Transformer.Config.MaxSeqLen
	}

	// Regularization — the cursa-C/D models had none and memorized
	// their tiny corpora (see roadmap §1.4). Both default ON now.
	org.Transformer.SetDropout(float32(cfg.dropout))
	fmt.Printf("Regularization: dropout=%.2f weight_decay=%.3f\n", cfg.dropout, cfg.weightDecay)

	fmt.Printf("Transformer params: %d (~%.2fM)\n",
		org.Transformer.ParamCount(),
		float64(org.Transformer.ParamCount())/1e6)
	fmt.Printf("Tokenizer vocab: %d, max seq: %d\n",
		org.Tokenizer.ActualVocabSize(), maxSeq)

	trainPool, evalPool, err := loadPools(cfg.corpora, cfg.evalLines, org.Tokenizer, maxSeq)
	if err != nil {
		return err
	}
	if len(trainPool) == 0 {
		return fmt.Errorf("training pool is empty — check corpus paths")
	}
	fmt.Printf("Train pool: %d sequences | Eval pool: %d sequences\n",
		len(trainPool), len(evalPool))

	startStep := readResumeStep(cfg.logPath)
	if startStep > 0 {
		fmt.Printf("[Resume] Found %d previously logged steps in %s — continuing.\n",
			startStep, cfg.logPath)
	}

	// The LR schedule operates on session-relative steps (0..remainingSteps)
	// rather than absolute step counts, so a resumed run gets its own fresh
	// warmup + cosine decay window instead of inheriting the tail of the
	// previous run's schedule.
	remainingSteps := cfg.totalSteps - startStep
	if remainingSteps < 1 {
		return fmt.Errorf("nothing to train: total-steps=%d but log already has %d steps",
			cfg.totalSteps, startStep)
	}
	warmupSteps := cfg.warmupSteps
	if warmupSteps >= remainingSteps {
		warmupSteps = remainingSteps / 10
	}
	sched := cortex.LRSchedule{
		WarmupSteps: warmupSteps,
		DecaySteps:  remainingSteps - warmupSteps,
		PeakLR:      float32(cfg.peakLR),
		MinLR:       float32(cfg.minLR),
	}
	fmt.Printf("Schedule: peak_lr=%.2e min_lr=%.2e warmup=%d session_steps=%d (total=%d, resume=%d) batch_size=%d\n",
		cfg.peakLR, cfg.minLR, warmupSteps, remainingSteps, cfg.totalSteps, startStep, cfg.batchSize)

	// Try to resume Adam moment buffers from disk. If the file is
	// absent (cold start) or its architecture no longer matches the
	// model (e.g. config changed), fall back to a fresh state and let
	// the schedule step counter come from the training log.
	adamCfg := cortex.DefaultAdamConfig()
	adamCfg.WeightDecay = float32(cfg.weightDecay)

	var adam *cortex.AdamState
	if loaded, lerr := cortex.LoadAdamState(org.Transformer, cfg.optimizerPath); lerr != nil {
		fmt.Printf("[Resume] Failed to load optimizer state from %s (%v) — starting fresh.\n",
			cfg.optimizerPath, lerr)
		adam = cortex.NewAdamState(org.Transformer, adamCfg)
		adam.Step = startStep
	} else if loaded != nil {
		fmt.Printf("[Resume] Loaded Adam state from %s (step=%d).\n",
			cfg.optimizerPath, loaded.Step)
		adam = loaded
		// The flag (or its default) decides regularization for THIS
		// session — a persisted config must not silently pin an old run's
		// (or zero) decay forever.
		adam.Cfg.WeightDecay = adamCfg.WeightDecay
		// Trust the optimizer's own step counter over the log if they
		// disagree — the moment buffers are what defines bias correction.
		if adam.Step < startStep {
			adam.Step = startStep
		}
	} else {
		adam = cortex.NewAdamState(org.Transformer, adamCfg)
		adam.Step = startStep
	}

	// Resident training weights: upload the matrices once so every
	// training matmul skips the per-call PCIe weight copy. Measured on
	// cursa E′ (17.7M params) this is the difference between ~12 s/step
	// and a usable overnight run.
	if compute.IsCuBLASAvailable() {
		if gerr := org.Transformer.EnableGPUTraining(); gerr != nil {
			fmt.Printf("[gpu] resident training weights unavailable (%v) — using per-call copies\n", gerr)
		} else {
			fmt.Println("[gpu] resident training weights active")
		}
	}

	logFile, err := openLogAppend(cfg.logPath, startStep == 0)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer logFile.Close()

	// Dump a JSON run manifest next to the log so this exact run is
	// reproducible later (corpus list, seed, all hyperparams, vocab
	// size, transformer arch). One file per launch, timestamp-tagged.
	if err := dumpRunManifest(cfg, org.Transformer, startStep); err != nil {
		fmt.Printf("[warn] could not write run manifest: %v\n", err)
	}

	// Auto-eval worker: pornit DOAR dacă --auto-eval e activ. Worker-ul
	// rulează broca-eval CPU-only după fiecare new-best checkpoint și
	// append-ează rezultatul la eval-history.jsonl. Folosește subprocess
	// ca să izoleze complet memoria de inferență de cea de training.
	//
	// Dacă nu se găsește binarul, lăsăm warning și dezactivăm hook-ul —
	// training-ul continuă neafectat.
	var autoEvalCh chan<- autoEvalRequest
	var closeAutoEval func()
	if cfg.autoEval {
		binPath, err := resolveAutoEvalBin(cfg.autoEvalBin)
		if err != nil {
			fmt.Printf("[auto-eval] DISABLED: %v\n", err)
		} else {
			fmt.Printf("[auto-eval] ENABLED: %s → %s (CoT=%v)\n",
				binPath, cfg.evalHistoryPath, cfg.autoEvalCoT)
			autoEvalCh, closeAutoEval = startAutoEvalWorker(cfg, binPath)
			defer closeAutoEval()
		}
	}

	// Best-checkpoint tracking. We keep the rolling "latest" checkpoint
	// at the canonical paths (transformer.nxtf / optimizer.nxto) AND a
	// frozen "best" snapshot at *.best.* whenever val_loss improves.
	// That way a divergent late-training spike can't destroy the best
	// model we've seen.
	bestVal := float32(math.Inf(1))
	bestStep := startStep
	noImprove := 0
	stepStart := time.Now()
	runStart := time.Now()
	const lossEMABeta = 0.98
	emaLoss := float32(0)
	emaInit := false

	// Throughput tracking. We count predicted tokens between heartbeats
	// (every 50 steps) and at every eval, then convert to tokens/sec.
	tokensSinceHeartbeat := 0
	tokensSinceEval := 0
	lastTokensPerSec := float32(0)

	// Graceful shutdown: on Ctrl+C (SIGINT) or SIGTERM, finish the
	// current step, save model + optimizer, then exit cleanly. We use a
	// done channel that the main loop polls between steps.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	stopRequested := false
	go func() {
		s := <-sigCh
		fmt.Printf("\n[signal] caught %v — will save and exit after this step.\n", s)
		stopRequested = true
	}()

	// Reusable batch buffer so we don't allocate per step.
	batch := make([][]int, 0, cfg.batchSize)

	saveCheckpoint := func(step int, val float32, tag string) error {
		fmt.Printf("  [ckpt] %s save at step %d (val_loss %.4f)\n", tag, step, val)
		if err := org.Save(cfg.dataDir); err != nil {
			return fmt.Errorf("save organism: %w", err)
		}
		if err := cortex.SaveAdamState(adam, cfg.optimizerPath); err != nil {
			return fmt.Errorf("save optimizer: %w", err)
		}
		return nil
	}

	saveBest := func(step int, val float32) error {
		// Copy the canonical files we just wrote to *.best.* so that
		// the "latest" and "best" snapshots can diverge later without
		// extra serialisation cost. transformer.nxtf is the only piece
		// of the organism that Broca 2.0 uses, so we only need to copy
		// that file plus the optimizer.
		srcModel := filepath.Join(cfg.dataDir, "transformer.nxtf")
		dstModel := filepath.Join(cfg.dataDir, "transformer.best.nxtf")
		if err := copyFile(srcModel, dstModel); err != nil {
			return fmt.Errorf("copy best model: %w", err)
		}
		dstOpt := cfg.optimizerPath + ".best"
		if err := copyFile(cfg.optimizerPath, dstOpt); err != nil {
			return fmt.Errorf("copy best optimizer: %w", err)
		}
		fmt.Printf("  [best] new best val_loss %.4f at step %d (frozen to %s)\n",
			val, step, filepath.Base(dstModel))
		return nil
	}

	for step := startStep + 1; step <= cfg.totalSteps; step++ {
		// Schedule sees session-relative step (1..remainingSteps).
		lr := sched.LR(step - startStep)
		var loss float32
		var stepToks int
		if cfg.batchSize <= 1 {
			seq := trainPool[rng.Intn(len(trainPool))]
			loss = org.Transformer.TrainStepAdam(seq, lr, adam)
			stepToks = len(seq) - 1
		} else {
			batch = batch[:0]
			for k := 0; k < cfg.batchSize; k++ {
				batch = append(batch, trainPool[rng.Intn(len(trainPool))])
			}
			loss = org.Transformer.TrainStepAdamBatch(batch, lr, adam)
			for _, s := range batch {
				stepToks += len(s) - 1
			}
		}
		tokensSinceHeartbeat += stepToks
		tokensSinceEval += stepToks

		if !emaInit {
			emaLoss = loss
			emaInit = true
		} else {
			emaLoss = lossEMABeta*emaLoss + (1-lossEMABeta)*loss
		}

		if step%50 == 0 {
			elapsed := time.Since(stepStart)
			tokPerSec := float32(0)
			if elapsed > 0 {
				tokPerSec = float32(float64(tokensSinceHeartbeat) / elapsed.Seconds())
			}
			lastTokensPerSec = tokPerSec
			fmt.Printf("  step %5d/%d  lr %.2e  loss %.4f  ema %.4f  grad %.2f  %.0f tok/s  (%s/50steps)\n",
				step, cfg.totalSteps, lr, loss, emaLoss, adam.LastGradNorm,
				tokPerSec, elapsed.Truncate(time.Millisecond))
			stepStart = time.Now()
			tokensSinceHeartbeat = 0
		}

		isEvalStep := step%cfg.evalEvery == 0 || step == cfg.totalSteps || stopRequested
		if isEvalStep {
			metrics := evaluate(org.Transformer, evalPool)
			elapsedSec := time.Since(runStart).Seconds()
			fmt.Printf("  [eval] step %d  val_loss %.4f  ppl %.2f  best %.4f (@%d)\n",
				step, metrics.MeanLoss, metrics.Perplexity, bestVal, bestStep)
			fmt.Fprintf(logFile,
				"%d\t%.6g\t%.6f\t%.6f\t%.4f\t%.4f\t%.1f\t%.1f\n",
				step, lr, emaLoss, metrics.MeanLoss, metrics.Perplexity,
				adam.LastGradNorm, lastTokensPerSec, elapsedSec)
			_ = logFile.Sync()
			tokensSinceEval = 0

			improved := metrics.MeanLoss < bestVal-1e-4
			if improved {
				bestVal = metrics.MeanLoss
				bestStep = step
				noImprove = 0
			} else {
				noImprove++
			}

			doCkpt := cfg.checkpointEvery > 0 &&
				(step%cfg.checkpointEvery == 0 || step == cfg.totalSteps || stopRequested)
			if doCkpt {
				if err := saveCheckpoint(step, metrics.MeanLoss, "latest"); err != nil {
					return err
				}
				if improved {
					if err := saveBest(step, metrics.MeanLoss); err != nil {
						fmt.Printf("[warn] best-save failed: %v\n", err)
					} else if autoEvalCh != nil {
						// Hook trigger: trimitem request către worker.
						// Non-blocking: dacă worker-ul e ocupat, skip
						// (sendAutoEval afișează un mesaj).
						req := autoEvalRequest{
							step:      step,
							valLoss:   metrics.MeanLoss,
							modelPath: filepath.Join(cfg.dataDir, "transformer.best.nxtf"),
						}
						sendAutoEval(autoEvalCh, req)
					}
				}
			}

			if cfg.earlyStopPatience > 0 && noImprove >= cfg.earlyStopPatience {
				fmt.Printf("  [early-stop] val loss did not improve for %d evals — stopping.\n",
					cfg.earlyStopPatience)
				break
			}
		}

		if stopRequested {
			fmt.Println("[signal] graceful stop after eval+ckpt.")
			break
		}
	}

	fmt.Printf("\nTraining finished in %s\n", time.Since(runStart).Truncate(time.Second))
	fmt.Printf("Best val loss: %.4f at step %d\n", bestVal, bestStep)
	fmt.Printf("Log: %s\n", cfg.logPath)
	return nil
}

// copyFile copies src to dst atomically: writes to dst+".tmp" first,
// then renames over dst. A concurrent reader will only ever see either
// the old complete file or the new complete file, never a half-written
// one. Streams in 1 MiB chunks so large checkpoints don't blow up RAM.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	buf := make([]byte, 1<<20) // 1 MiB
	for {
		n, rerr := in.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				_ = out.Close()
				_ = os.Remove(tmp)
				return werr
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				break
			}
			_ = out.Close()
			_ = os.Remove(tmp)
			return rerr
		}
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// dumpRunManifest writes a JSON file describing this exact training
// run: hyperparameters, corpus list, vocab + arch sizes, resume step,
// timestamp. One file per launch under <data-dir>/runs/.
func dumpRunManifest(cfg trainConfig, m *cortex.MiniTransformer, startStep int) error {
	dir := filepath.Join(cfg.dataDir, "runs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	path := filepath.Join(dir, fmt.Sprintf("run-%s.json", stamp))
	manifest := map[string]any{
		"timestamp":     time.Now().Format(time.RFC3339),
		"data_dir":      cfg.dataDir,
		"corpora":       cfg.corpora,
		"peak_lr":       cfg.peakLR,
		"min_lr":        cfg.minLR,
		"warmup_steps":  cfg.warmupSteps,
		"total_steps":   cfg.totalSteps,
		"batch_size":    cfg.batchSize,
		"max_seq_len":   cfg.maxSeqLen,
		"eval_lines":    cfg.evalLines,
		"eval_every":    cfg.evalEvery,
		"ckpt_every":    cfg.checkpointEvery,
		"early_stop":    cfg.earlyStopPatience,
		"seed":          cfg.seed,
		"log_path":      cfg.logPath,
		"optimizer":     cfg.optimizerPath,
		"resume_step":   startStep,
		"vocab_size":    m.Config.VocabSize,
		"max_seq_model": m.Config.MaxSeqLen,
		"embed_dim":     m.Config.EmbedDim,
		"num_layers":    m.Config.NumLayers,
		"num_heads":     m.Config.NumHeads,
		"ffn_dim":       m.Config.FFNDim,
		"params":        m.ParamCount(),
	}
	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return err
	}
	fmt.Printf("[manifest] %s\n", path)
	return nil
}

func loadPools(paths []string, evalLines int, tok *cortex.BPETokenizer, maxSeq int) (train, eval [][]int, err error) {
	for _, p := range paths {
		seqs, err := loadCorpus(p, tok, maxSeq)
		if err != nil {
			return nil, nil, err
		}
		if len(seqs) == 0 {
			fmt.Printf("[warn] %s yielded 0 sequences\n", p)
			continue
		}
		split := len(seqs) - evalLines
		if split < 1 {
			split = len(seqs)
		}
		train = append(train, seqs[:split]...)
		if split < len(seqs) {
			eval = append(eval, seqs[split:]...)
		}
		fmt.Printf("  %s: %d train + %d eval\n", filepath.Base(p), split, len(seqs)-split)
	}
	return train, eval, nil
}

func loadCorpus(path string, tok *cortex.BPETokenizer, maxSeq int) ([][]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var out [][]int
	for scanner.Scan() {
		text := extractCorpusText(scanner.Text())
		if len(text) < 20 {
			continue
		}
		ids := tok.EncodeWithSpecial(text)
		if len(ids) < 3 {
			continue
		}
		if len(ids) > maxSeq+1 {
			ids = ids[:maxSeq+1]
		}
		out = append(out, ids)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// extractCorpusText mirrors cortex.extractCorpusText (kept inline so
// this command does not need an exported helper).
func extractCorpusText(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || line[0] != '{' {
		return ""
	}
	var data map[string]interface{}
	if err := json.Unmarshal([]byte(line), &data); err != nil {
		return ""
	}
	if t, ok := data["text"].(string); ok && t != "" {
		return t
	}
	instruction, _ := data["instruction"].(string)
	response, _ := data["response"].(string)
	if instruction != "" && response != "" {
		return instruction + " " + response
	}
	input, _ := data["input"].(string)
	output, _ := data["output"].(string)
	if input != "" && output != "" {
		return input + " " + output
	}
	return ""
}

// evalMetrics holds per-token validation statistics.
type evalMetrics struct {
	MeanLoss   float32 // sum(per-token NLL) / total predicted tokens
	Perplexity float32 // exp(MeanLoss)
	TotalToks  int
	NumSeqs    int
}

// evaluate returns per-token cross-entropy on a held-out pool. This is
// more meaningful than averaging the per-sequence mean loss because it
// weights long sequences correctly, and lets us compute a real
// perplexity instead of an arbitrary scaled one.
func evaluate(m *cortex.MiniTransformer, pool [][]int) evalMetrics {
	if len(pool) == 0 {
		return evalMetrics{}
	}
	var sumLoss float64
	var totalToks int
	var n int
	for _, seq := range pool {
		if len(seq) < 2 {
			continue
		}
		seqLen := len(seq) - 1
		if seqLen > m.Config.MaxSeqLen {
			seqLen = m.Config.MaxSeqLen
		}
		input := seq[:seqLen]
		target := seq[1 : seqLen+1]
		logits := m.ForwardTrain(input)
		// CrossEntropyLoss returns the MEAN over tokens; multiply back
		// to get the SUM, then divide by total token count at the end.
		meanLoss := cortex.CrossEntropyLoss(logits, target)
		sumLoss += float64(meanLoss) * float64(len(target))
		totalToks += len(target)
		n++
	}
	if totalToks == 0 {
		return evalMetrics{}
	}
	mean := float32(sumLoss / float64(totalToks))
	return evalMetrics{
		MeanLoss:   mean,
		Perplexity: float32(math.Exp(float64(mean))),
		TotalToks:  totalToks,
		NumSeqs:    n,
	}
}

// logHeader lists every column written to training.log. Keep this in
// sync with the fmt.Fprintf call in the eval branch of run().
const logHeader = "step\tlr\ttrain_loss_ema\tval_loss\tval_ppl\tgrad_norm\ttokens_per_sec\telapsed_sec"

func openLogAppend(path string, writeHeader bool) (*os.File, error) {
	if writeHeader {
		f, err := os.Create(path)
		if err != nil {
			return nil, err
		}
		fmt.Fprintln(f, logHeader)
		return f, nil
	}
	return os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
}

// readResumeStep returns the highest step index recorded in the log.
// Accepts both the old 4-column format (step, lr, train_loss, val_loss)
// and the new richer format — only the first field matters here.
func readResumeStep(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	last := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "step\t") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 1 {
			continue
		}
		var step int
		if _, err := fmt.Sscanf(fields[0], "%d", &step); err == nil && step > last {
			last = step
		}
	}
	return last
}

// runSubprocess execută binarul `bin` cu argumentele date, capturând
// stdout+stderr într-un singur buffer. Returnează output-ul combinat
// plus eroarea (nil dacă exit code 0).
//
// Mediu: scoatem orice variabilă CUDA care ar putea fi setată ca să ne
// asigurăm că subprocess-ul rămâne CPU-only chiar dacă training-ul
// rulează pe GPU. broca-eval are deja default --gpu=false, dar facem
// defense-in-depth aici.
func runSubprocess(bin string, args []string) ([]byte, error) {
	cmd := exec.Command(bin, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	// Forțăm CPU-only: ștergem flag-urile CUDA din environment.
	env := os.Environ()
	filtered := env[:0]
	for _, e := range env {
		if strings.HasPrefix(e, "CUDA_VISIBLE_DEVICES=") {
			continue
		}
		filtered = append(filtered, e)
	}
	filtered = append(filtered, "CUDA_VISIBLE_DEVICES=-1")
	cmd.Env = filtered

	err := cmd.Run()
	return buf.Bytes(), err
}

// tailLines returnează ultimele n linii din buf (string), util pentru
// log-uri compacte la eroare. Dacă buf are mai puține linii, le
// întoarce pe toate. Liniile vide sunt păstrate.
func tailLines(buf []byte, n int) string {
	if n <= 0 || len(buf) == 0 {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	if len(lines) <= n {
		return strings.Join(lines, " | ")
	}
	return strings.Join(lines[len(lines)-n:], " | ")
}
