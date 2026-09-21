package cortex

import (
	"fmt"
	"strconv"
)

// NoConfidentResponse is the sentinel returned when no prediction meets confidence threshold.
const NoConfidentResponse = "(no confident response)"

// Config represents all configurations, sizes, thresholds, seeds, paths,
// and learning knobs for the Nexus Cortex digital organism.
type Config struct {
	DataDir     string `json:"data_dir"`
	Seed        int64  `json:"seed"`
	Demo        bool   `json:"demo"`
	NoSave      bool   `json:"no_save"`
	Fresh       bool   `json:"fresh"`
	MaxGenWords int    `json:"max_gen_words"`
	SDRSize     int    `json:"sdr_size"`
	ActiveCount int    `json:"active_count"`
	MaxMemories int    `json:"max_memories"`
	ThinkCycles int    `json:"think_cycles"`

	CerebellumConfThreshold uint8  `json:"cerebellum_conf_threshold"`
	HippocampusRecallThresh uint8  `json:"hippocampus_recall_thresh"`
	PrefrontalConfThreshold uint8  `json:"prefrontal_conf_threshold"`
	BrainPruneMaxAge        uint8  `json:"brain_prune_max_age"`
	CerebellumMinUseCount   uint32 `json:"cerebellum_min_use_count"`
	PrefrontalPruneThresh   uint8  `json:"prefrontal_prune_thresh"`

	// Thousand Brains configuration
	ThousandBrainsColumns         int     `json:"thousand_brains_columns"`
	ThousandBrainsColNeurons      int     `json:"thousand_brains_col_neurons"`
	ThousandBrainsColConnectivity float64 `json:"thousand_brains_col_connectivity"`
	ThousandBrainsProcessTicks    int     `json:"thousand_brains_process_ticks"`
	ThousandBrainsInputCurrent    uint8   `json:"thousand_brains_input_current"`

	// Reward System configuration
	RewardSystemCapacity int `json:"reward_system_capacity"`

	// Emotion Engine configuration
	EmotionHistoryCapacity  int   `json:"emotion_history_capacity"`
	EmotionMomentumDecay    uint8 `json:"emotion_momentum_decay"`
	EmotionValenceWeight    uint8 `json:"emotion_valence_weight"`
	EmotionArousalWeight    uint8 `json:"emotion_arousal_weight"`
	EmotionCuriosityWeight  uint8 `json:"emotion_curiosity_weight"`
	EmotionConfidenceWeight uint8 `json:"emotion_confidence_weight"`
	EmotionSocialWeight     uint8 `json:"emotion_social_weight"`

	// Curiosity Drive configuration
	CuriosityHistoryCapacity int `json:"curiosity_history_capacity"`

	// Sensory System configuration
	SensoryBufferCapacity          int `json:"sensory_buffer_capacity"`
	SensoryTextIntensityScale      int `json:"sensory_text_intensity_scale"`
	SensoryNumericIntensityScale   int `json:"sensory_numeric_intensity_scale"`
	SensoryTemporalSequenceScale   int `json:"sensory_temporal_sequence_scale"`
	SensoryTemporalRepetitionScale int `json:"sensory_temporal_repetition_scale"`

	// Motor System configuration
	MotorQueueCapacity   int `json:"motor_queue_capacity"`
	MotorHistoryCapacity int `json:"motor_history_capacity"`

	// Cognitive Workspace configuration
	MinAttentionSalience int `json:"min_attention_salience"`

	// Prefrontal Reasoning configuration
	PrefrontalNetSize           int     `json:"prefrontal_net_size"`
	PrefrontalConnectivity      float64 `json:"prefrontal_connectivity"`
	PrefrontalInputCurrent      uint8   `json:"prefrontal_input_current"`
	PrefrontalMaxHops           int     `json:"prefrontal_max_hops"`
	PrefrontalConvergenceThresh uint8   `json:"prefrontal_convergence_thresh"`

	// Encoder configuration
	EncoderContextMaxSize int `json:"encoder_context_max_size"`

	// Self-Model threshold configuration
	SelfKnowsAboutThreshold  uint32 `json:"self_knows_about_threshold"`
	SelfWeakTopicThreshold   uint32 `json:"self_weak_topic_threshold"`
	SelfStrongTopicThreshold uint32 `json:"self_strong_topic_threshold"`

	// Network & LIF Neuron configuration
	NetworkExcitatoryRatioNumerator int   `json:"network_excitatory_ratio_numerator"` // e.g. 4 for 4/5 (80%)
	NeuronMinThreshold              uint8 `json:"neuron_min_threshold"`
	NeuronMaxThreshold              uint8 `json:"neuron_max_threshold"`
	NeuronMinLeak                   uint8 `json:"neuron_min_leak"`
	NeuronMaxLeak                   uint8 `json:"neuron_max_leak"`
	SynapseMinWeight                uint8 `json:"synapse_min_weight"`
	SynapseMaxWeight                uint8 `json:"synapse_max_weight"`
	SynapseMinDelay                 uint8 `json:"synapse_min_delay"`
	SynapseMaxDelay                 uint8 `json:"synapse_max_delay"`

	// Hippocampus (Episodic Memory) configuration
	HippoReconsolidationThresh uint8 `json:"hippo_reconsolidation_thresh"`
	HippoInitialStrength       uint8 `json:"hippo_initial_strength"`
	HippoLtpThreshold          uint8 `json:"hippo_ltp_threshold"`

	// Broca Language Generation configuration
	BrocaConfidenceProximity  uint8  `json:"broca_confidence_proximity"`
	BrocaTopNCandidates       int    `json:"broca_top_n_candidates"`
	BrocaSequentialMultiplier uint16 `json:"broca_sequential_multiplier"`

	// Rhythm Engine configuration
	RhythmSleepThreshold uint8 `json:"rhythm_sleep_threshold"`

	// Wernicke Language Comprehension configuration
	WernickeKeywordThreshold uint32 `json:"wernicke_keyword_threshold"`

	// Sequence Memory configuration
	SequenceMemoryMaxTargets      int    `json:"sequence_memory_max_targets"`
	SequenceMemoryIncrementWeight uint16 `json:"sequence_memory_increment_weight"`
	SequenceMemoryLTPAmount       uint16 `json:"sequence_memory_ltp_amount"` // LTP reinforcement delta (default 50)
	SequenceMemoryLTDAmount       uint16 `json:"sequence_memory_ltd_amount"` // LTD weakening delta (default 40)

	// STDP Learning configuration
	StdpPotentiate uint8 `json:"stdp_potentiate"`
	StdpDepress    uint8 `json:"stdp_depress"`
	StdpTraceDecay uint8 `json:"stdp_trace_decay"`
	StdpMaxWeight  uint8 `json:"stdp_max_weight"`

	// Neuron Dynamics configuration
	NeuronRefractoryPeriod    uint8 `json:"neuron_refractory_period"`
	HomeostaticSpikeIncrement uint8 `json:"homeostatic_spike_increment"`
	HomeostaticBaselineFloor  uint8 `json:"homeostatic_baseline_floor"`
	HomeostaticDecayRate      uint8 `json:"homeostatic_decay_rate"`

	// WTA Columnar Inhibition configuration
	WtaColumnSize       int    `json:"wta_column_size"`
	WtaTraceIncrement   uint32 `json:"wta_trace_increment"`
	WtaActivationThresh uint32 `json:"wta_activation_thresh"`
	WtaMaxInhibition    uint16 `json:"wta_max_inhibition"`

	// Noradrenergic Reset configuration
	NoradrenergicChaosThresholdPct int    `json:"noradrenergic_chaos_threshold_pct"`
	NoradrenergicChaosCounterLimit int    `json:"noradrenergic_chaos_counter_limit"`
	NoradrenergicThresholdBoost    uint8  `json:"noradrenergic_threshold_boost"`
	NoradrenergicDampeningTicks    uint16 `json:"noradrenergic_dampening_ticks"`
	NoradrenergicDampeningBias     uint16 `json:"noradrenergic_dampening_bias"`
	NoradrenergicCooldownPct       int    `json:"noradrenergic_cooldown_pct"`

	// Brain Learning Weight configuration
	BrainBigramWeight        uint16 `json:"brain_bigram_weight"`
	BrainSkipgramWeight      uint16 `json:"brain_skipgram_weight"`
	BrainSemanticWeight      uint16 `json:"brain_semantic_weight"`
	BrainContextWindowSize   int    `json:"brain_context_window_size"`
	FeedbackLTPAmount        uint16 `json:"feedback_ltp_amount"`
	FeedbackLTDAmount        uint16 `json:"feedback_ltd_amount"`
	FeedbackNewSynapseWeight uint16 `json:"feedback_new_synapse_weight"`

	// Broca Generation configuration
	BrocaDecodeTopK int `json:"broca_decode_top_k"`

	// Self-Training configuration
	SelfTrainMaxTopics    int   `json:"self_train_max_topics"`
	SelfTrainRecallThresh uint8 `json:"self_train_recall_thresh"`
	SelfTrainStableConf   uint8 `json:"self_train_stable_conf"`
	SelfTrainUnstableConf uint8 `json:"self_train_unstable_conf"`

	// Curiosity Dynamics configuration
	CuriosityBoredThreshold     uint8 `json:"curiosity_bored_threshold"`
	CuriosityOverwhelmThreshold uint8 `json:"curiosity_overwhelm_threshold"`
	CuriosityInterestIncrement  uint8 `json:"curiosity_interest_increment"`
	CuriosityInterestDecay      uint8 `json:"curiosity_interest_decay"`
	CuriosityRateStep           uint8 `json:"curiosity_rate_step"`

	// Emotion Dynamics configuration
	EmotionStabilityThreshold     int   `json:"emotion_stability_threshold"`
	EmotionConfidenceBaseline     uint8 `json:"emotion_confidence_baseline"`
	EmotionCuriositySweetSpotLow  uint8 `json:"emotion_curiosity_sweet_spot_low"`  // Lower boundary for curiosity (default 30)
	EmotionCuriositySweetSpotHigh uint8 `json:"emotion_curiosity_sweet_spot_high"` // Upper boundary for curiosity (default 100)

	// Reward Curve configuration
	RewardSweetSpotLow  uint8 `json:"reward_sweet_spot_low"`
	RewardSweetSpotHigh uint8 `json:"reward_sweet_spot_high"`
	RewardLowValue      int8  `json:"reward_low_value"`

	// Predictor configuration
	PredictorWindowSize int `json:"predictor_window_size"`
	PredictorUnionDepth int `json:"predictor_union_depth"`
	PredictorMaxHistory int `json:"predictor_max_history"`

	// Workspace (consciousness) configuration
	WorkspaceMaxQueueSize    int   `json:"workspace_max_queue_size"`
	WorkspaceFocusDuration   int   `json:"workspace_focus_duration"`
	WorkspaceAttentionThresh uint8 `json:"workspace_attention_thresh"`

	// Cerebellum configuration
	CerebellumMaxCacheSize int `json:"cerebellum_max_cache_size"`

	// Working Memory configuration
	WorkingMemoryCapacity     int   `json:"working_memory_capacity"`
	WorkingMemoryDecayRate    uint8 `json:"working_memory_decay_rate"`
	WorkingMemoryMinRelevance uint8 `json:"working_memory_min_relevance"`

	// Beam Search configuration
	BeamSearchWidth                int `json:"beam_search_width"`
	BeamSearchMaxCandidatesPerStep int `json:"beam_search_max_candidates_per_step"`

	// Error-Driven Learning configuration
	ErrorLearningStrength  uint8 `json:"error_learning_strength"`  // Max synapse adjustment per call
	ErrorLearningThreshold uint8 `json:"error_learning_threshold"` // Min prediction error to trigger

	// Attention Module configuration
	AttentionHistorySize    int   `json:"attention_history_size"`    // Ring buffer capacity for context history
	AttentionMinWeight      uint8 `json:"attention_min_weight"`      // Minimum weight to keep a bit active
	AttentionContextBoost   uint8 `json:"attention_context_boost"`   // Bonus weight for bits active in current context
	AttentionFrequencyScale uint8 `json:"attention_frequency_scale"` // Weight per historical occurrence

	// Analogy Engine configuration
	AnalogyMaxCandidates int `json:"analogy_max_candidates"` // Max vocab words to scan during analogy search

	// Sleep Consolidation configuration
	SleepReplayCount     int   `json:"sleep_replay_count"`     // Memories replayed per sleep cycle
	SleepInterleaveRatio int   `json:"sleep_interleave_ratio"` // Old memories per new memory during replay
	SleepStabilityThresh uint8 `json:"sleep_stability_thresh"` // Min prefrontal stability to reinforce

	// Autonomous Learning configuration — all previously hardcoded
	AutoSeedTopics      []string `json:"auto_seed_topics,omitempty"`   // Initial curiosity topics
	AutoSeedDatasets    []string `json:"auto_seed_datasets,omitempty"` // HuggingFace dataset IDs
	AutoSearchLangs     []string `json:"auto_search_langs,omitempty"`  // Wikipedia search languages
	AutoHFRowsPerDS     int      `json:"auto_hf_rows_per_ds"`          // Max rows per HF dataset
	AutoLearnInterval   int      `json:"auto_learn_interval_secs"`     // Seconds between learn cycles
	AutoMaxGapsPerCycle int      `json:"auto_max_gaps_per_cycle"`      // Max gaps to address per cycle

	// Web server configuration
	WebPort     string `json:"web_port,omitempty"`      // Dashboard port (default "8080")
	WebBindAddr string `json:"web_bind_addr,omitempty"` // Bind address (default "127.0.0.1")

	// WebLearner HTTP configuration — previously hardcoded
	WebLearnerTimeoutSecs int    `json:"web_learner_timeout_secs"`  // HTTP request timeout
	WebLearnerRateLimitMs int    `json:"web_learner_rate_limit_ms"` // Min pause between requests (ms)
	WebLearnerBodyLimitMB int    `json:"web_learner_body_limit_mb"` // Max HTTP response body (MB)
	WebLearnerUserAgent   string `json:"web_learner_user_agent,omitempty"`
	WebLearnerWikiBaseURL string `json:"web_learner_wiki_base_url,omitempty"` // e.g. "wikipedia.org"
	WebLearnerHFSearchURL string `json:"web_learner_hf_search_url,omitempty"`
	WebLearnerHFRowsURL   string `json:"web_learner_hf_rows_url,omitempty"`

	// WebGPU hardware acceleration configuration
	WebGPUTimeoutSecs int `json:"webgpu_timeout_secs"`

	// Quantum-Inspired Engine configuration
	EnableQuantumInspired bool  `json:"enable_quantum_inspired"` // Use QuantumRouter instead of ExpertRouter
	QuantumTemperature    uint8 `json:"quantum_temperature"`     // PBit temperature (0=deterministic, 255=max stochastic)
	QuantumMultiSamples   int   `json:"quantum_multi_samples"`   // Multi-sample passes (1=no multi-sample)

	// RadioCortex configuration
	RadioCortexEnabled bool `json:"radio_cortex_enabled"` // Enable RadioCortex (default false)

	// Biomed organ (cortex/biomed): answers only from live public sources
	// (RxNorm, ChEMBL, openFDA, Open Targets, PubMed) cached under BiomedCacheDir.
	BiomedEnabled     bool   `json:"biomed_enabled"`             // Enable the biomedical Tool (default false)
	BiomedCacheDir    string `json:"biomed_cache_dir,omitempty"` // Cache + knowledge graph dir (default ./data/knowledge/biomed)
	RadioNeuronCount  int    `json:"radio_neuron_count"`         // Number of radio neurons (default 1_000_000)
	TrainingDataDir   string `json:"training_data_dir"`          // Directory with qa.json and texts.txt
	NeuroRadioEnabled bool   `json:"neuro_radio_enabled"`        // Enable NeuroRadioCortex (unified architecture)

	// SignalCodec configuration
	SignalCodecInitVocab  int `json:"signal_codec_init_vocab"`   // Initial vocab size for SignalCodec (default 1000)
	SignalCodecFreqsPerTk int `json:"signal_codec_freqs_per_tk"` // Frequencies per token (default 13)
	SignalCodecMaxFreqs   int `json:"signal_codec_max_freqs"`    // Max frequencies per token cap (default 64)

	// RadioCortex generation/training
	RadioTrainAmplitude      int `json:"radio_train_amplitude"`       // Amplitude for training/generation (default 200)
	RadioResonanceThreshold  int `json:"radio_resonance_threshold"`   // Resonance threshold for input activation (default 20)
	RadioWeakNeuronThreshold int `json:"radio_weak_neuron_threshold"` // Weak neuron frequency drift threshold (default 32)
	RadioGenerateWindowSize  int `json:"radio_generate_window_size"`  // Generation context window size (default 8)
	RadioAntiLoopMaxRepeat   int `json:"radio_anti_loop_max_repeat"`  // Anti-loop repetition max (default 2)
	RadioDecodeTopK          int `json:"radio_decode_top_k"`          // Decode top-K fallback k (default 5)

	// NeuroRadioCortex
	NRCDecodeActiveThreshold int `json:"nrc_decode_active_threshold"` // ActiveChannels threshold in Decode (default 5)
	NRCInitAmpMin            int `json:"nrc_init_amp_min"`            // Initial amplitude minimum (default 100)
	NRCInitAmpRange          int `json:"nrc_init_amp_range"`          // Initial amplitude range (default 156)
	NRCInhibitoryRatioDiv    int `json:"nrc_inhibitory_ratio_div"`    // Inhibitory ratio divisor: 1/N (default 5 → 20%)
	NRCInjectAmplitude       int `json:"nrc_inject_amplitude"`        // Inject amplitude for ProcessInput/TrainStep (default 200)

	// FractalCortex
	FractalNumLayers             int     `json:"fractal_num_layers"`             // Layers per cortex block (default 24)
	FractalContextLen            int     `json:"fractal_context_len"`            // Attention context length (default 50)
	FractalTopK                  int     `json:"fractal_top_k"`                  // Top-K for SharedCortexStack (default 3)
	FractalDecayRate             int     `json:"fractal_decay_rate"`             // LinearScan decay rate (default 64)
	FractalPerturbRate           int     `json:"fractal_perturb_rate"`           // Perturbation rate 0-255 (default 25)
	FractalNeurogenesisThreshold float64 `json:"fractal_neurogenesis_threshold"` // Error threshold for spawning blocks (default 0.8)
	FractalMaxBlocks             int     `json:"fractal_max_blocks"`             // Max cortex blocks (default 8)

	// Self-Training
	SelfEvolveLearningRate float64 `json:"self_evolve_lr"`         // Learning rate for self-evolution (default 0.0001)
	SelfEvolveBatchSize    int     `json:"self_evolve_batch_size"` // Batch size per sleep cycle (default 50)
	BPEMaxLinesPerFile     int     `json:"bpe_max_lines_per_file"` // Max lines per file for BPE training (default 10000)

	// Transformer defaults
	TransformerEmbedDim  int `json:"transformer_embed_dim"`   // Hidden dimension (default 256)
	TransformerNumHeads  int `json:"transformer_num_heads"`   // Attention heads (default 4)
	TransformerNumLayers int `json:"transformer_num_layers"`  // Transformer blocks (default 4)
	TransformerFFNDim    int `json:"transformer_ffn_dim"`     // FFN inner dimension (default 1024)
	TransformerMaxSeqLen int `json:"transformer_max_seq_len"` // Max sequence length (default 512)
	// Modern-architecture switches for from-scratch models (cursa E'+).
	// Both MUST stay false for imported GPT-2 checkpoints, whose weights
	// assume absolute positions and a GELU MLP.
	TransformerUseRoPE   bool    `json:"transformer_use_rope"`   // Rotary positions (default false)
	TransformerUseSwiGLU bool    `json:"transformer_use_swiglu"` // Gated SiLU FFN (default false)
	TransformerDropout   float32 `json:"transformer_dropout"`    // Training dropout rate (default 0)

	// Adam optimizer hyperparameters. Sursa unică pentru DefaultAdamConfig
	// din transformer_optimizer.go. Modificabile fără recompilare prin
	// fișier JSON (vezi LoadConfig).
	AdamBeta1       float32 `json:"adam_beta1"`         // 1st-moment decay (default 0.9)
	AdamBeta2       float32 `json:"adam_beta2"`         // 2nd-moment decay (default 0.999)
	AdamEpsilon     float32 `json:"adam_epsilon"`       // Numerical stability (default 1e-8)
	AdamMaxGradNorm float32 `json:"adam_max_grad_norm"` // Global L2 grad clip (default 1.0; <=0 disables)
	AdamWeightDecay float32 `json:"adam_weight_decay"`  // AdamW decoupled decay on weight matrices (default 0 = off)

	// Chain-of-Thought / Self-Consistency (opt-in, free quality boost
	// on top of Broca 2.0 with no retraining).
	CoTEnabled         bool    `json:"cot_enabled"`          // Enable CoT primer + Self-Consistency in Broca path
	CoTSamples         int     `json:"cot_samples"`          // Independent samples to vote on (1 = disabled, 3-5 sweet spot)
	CoTBaseTemperature float32 `json:"cot_base_temperature"` // Centre temperature for sample spread (default 0.8)
	CoTUsePrimer       bool    `json:"cot_use_primer"`       // Prepend "let's think step by step" primer

	// Semantic Memory configuration
	SemanticMemorySimThreshold uint8 `json:"semantic_memory_sim_threshold"` // Similarity threshold for concept match (default 80)

	// Web Learner URL allowlist
	WebLearnerAllowedDomains []string `json:"web_learner_allowed_domains,omitempty"` // Allowed domains for SSRF check

	// Embedding configuration
	EmbeddingUnkTokenID int `json:"embedding_unk_token_id"` // UNK token ID fallback (default 1)

	// Autonomous learner
	AutoLowConfThreshold int `json:"auto_low_conf_threshold"` // Low confidence threshold (default 100)

	// Master Bug Fix & Audit Verification parameters
	SelfEvaluatorPassThreshold    float64 `json:"self_evaluator_pass_threshold"`
	FeedbackPositiveReward        int8    `json:"feedback_positive_reward"`
	FeedbackNegativeReward        int8    `json:"feedback_negative_reward"`
	FeedbackNegativeArousal       uint8   `json:"feedback_negative_arousal"`
	AutoLearnErrorBoost           uint8   `json:"auto_learn_error_boost"`
	CorpusMinTextLen              int     `json:"corpus_min_text_len"`
	MemoryMinTextLen              int     `json:"memory_min_text_len"`
	SemanticMemoryConceptMaturity int     `json:"semantic_memory_concept_maturity"`
	SemanticMemoryMinViableBits   int     `json:"semantic_memory_min_viable_bits"`
	AutoMaxGaps                   int     `json:"auto_max_gaps"`
	TransformerEOSTokenID         int     `json:"transformer_eos_token_id"`
}

// DefaultConfig returns a configuration with sensible biological and cognitive defaults.
func DefaultConfig() Config {
	return Config{
		DataDir:                 "./data/cortex",
		BiomedCacheDir:          "./data/knowledge/biomed",
		Seed:                    42,
		Demo:                    true,
		NoSave:                  false,
		Fresh:                   false,
		MaxGenWords:             20,
		SDRSize:                 10000,
		ActiveCount:             50,
		MaxMemories:             10000,
		ThinkCycles:             10,
		CerebellumConfThreshold: 178,
		HippocampusRecallThresh: 180,
		PrefrontalConfThreshold: 128,
		BrainPruneMaxAge:        200,
		CerebellumMinUseCount:   2,
		PrefrontalPruneThresh:   5,

		// Thousand Brains defaults
		ThousandBrainsColumns:         64,
		ThousandBrainsColNeurons:      100,
		ThousandBrainsColConnectivity: 0.10,
		ThousandBrainsProcessTicks:    5,
		ThousandBrainsInputCurrent:    200,

		// Reward System defaults
		RewardSystemCapacity: 1000,

		// Emotion Engine defaults
		EmotionHistoryCapacity:  100,
		EmotionMomentumDecay:    10,
		EmotionValenceWeight:    70,
		EmotionArousalWeight:    40,
		EmotionCuriosityWeight:  35,
		EmotionConfidenceWeight: 20,
		EmotionSocialWeight:     25,

		// Curiosity Drive defaults
		CuriosityHistoryCapacity: 500,

		// Sensory System defaults
		SensoryBufferCapacity:          100,
		SensoryTextIntensityScale:      32,
		SensoryNumericIntensityScale:   64,
		SensoryTemporalSequenceScale:   8,
		SensoryTemporalRepetitionScale: 128,

		// Motor System defaults
		MotorQueueCapacity:   10,
		MotorHistoryCapacity: 1000,

		// Cognitive Workspace defaults
		MinAttentionSalience: 50,

		// Prefrontal Reasoning defaults
		PrefrontalNetSize:           3000,
		PrefrontalConnectivity:      0.05,
		PrefrontalInputCurrent:      128,
		PrefrontalMaxHops:           3,
		PrefrontalConvergenceThresh: 240,

		// Encoder defaults
		EncoderContextMaxSize: 10,

		// Self-Model threshold defaults
		SelfKnowsAboutThreshold:  50,
		SelfWeakTopicThreshold:   30,
		SelfStrongTopicThreshold: 200,

		// Network & LIF Neuron defaults
		NetworkExcitatoryRatioNumerator: 4,
		NeuronMinThreshold:              100,
		NeuronMaxThreshold:              200,
		NeuronMinLeak:                   1,
		NeuronMaxLeak:                   4,
		SynapseMinWeight:                10,
		SynapseMaxWeight:                80,
		SynapseMinDelay:                 1,
		SynapseMaxDelay:                 4,

		// Hippocampus (Episodic Memory) defaults
		HippoReconsolidationThresh: 204,
		HippoInitialStrength:       10,
		HippoLtpThreshold:          128,

		// Broca Language Generation defaults
		BrocaConfidenceProximity:  15,
		BrocaTopNCandidates:       5,
		BrocaSequentialMultiplier: 3,

		// Rhythm Engine defaults
		RhythmSleepThreshold: 200,

		// Wernicke Language Comprehension defaults
		WernickeKeywordThreshold: 2,

		// Sequence Memory defaults
		SequenceMemoryMaxTargets:      64,
		SequenceMemoryIncrementWeight: 10,
		SequenceMemoryLTPAmount:       50,
		SequenceMemoryLTDAmount:       40,

		// STDP Learning defaults
		StdpPotentiate: 10,
		StdpDepress:    6,
		StdpTraceDecay: 20,
		StdpMaxWeight:  250,

		// Neuron Dynamics defaults
		NeuronRefractoryPeriod:    15,
		HomeostaticSpikeIncrement: 8,
		HomeostaticBaselineFloor:  80,
		HomeostaticDecayRate:      1,

		// WTA Columnar Inhibition defaults
		WtaColumnSize:       100,
		WtaTraceIncrement:   256,
		WtaActivationThresh: 50,
		WtaMaxInhibition:    100,

		// Noradrenergic Reset defaults
		NoradrenergicChaosThresholdPct: 30,
		NoradrenergicChaosCounterLimit: 8,
		NoradrenergicThresholdBoost:    30,
		NoradrenergicDampeningTicks:    10,
		NoradrenergicDampeningBias:     15,
		NoradrenergicCooldownPct:       5,

		// Brain Learning Weight defaults
		BrainBigramWeight:        10,
		BrainSkipgramWeight:      5,
		BrainSemanticWeight:      2,
		BrainContextWindowSize:   5,
		FeedbackLTPAmount:        50,
		FeedbackLTDAmount:        40,
		FeedbackNewSynapseWeight: 50,

		// Broca Generation defaults
		BrocaDecodeTopK: 50,

		// Self-Training defaults
		SelfTrainMaxTopics:    5,
		SelfTrainRecallThresh: 50,
		SelfTrainStableConf:   200,
		SelfTrainUnstableConf: 100,

		// Curiosity Dynamics defaults
		CuriosityBoredThreshold:     40,
		CuriosityOverwhelmThreshold: 200,
		CuriosityInterestIncrement:  10,
		CuriosityInterestDecay:      5,
		CuriosityRateStep:           10,

		// Emotion Dynamics defaults
		EmotionStabilityThreshold:     30,
		EmotionConfidenceBaseline:     128,
		EmotionCuriositySweetSpotLow:  30,
		EmotionCuriositySweetSpotHigh: 100,

		// Reward Curve defaults
		RewardSweetSpotLow:  30,
		RewardSweetSpotHigh: 100,
		RewardLowValue:      10,

		// Predictor defaults
		PredictorWindowSize: 5,
		PredictorUnionDepth: 3,
		PredictorMaxHistory: 100,

		// Workspace defaults
		WorkspaceMaxQueueSize:    32,
		WorkspaceFocusDuration:   5,
		WorkspaceAttentionThresh: 128,

		// Cerebellum defaults
		CerebellumMaxCacheSize: 10000,

		// Working Memory defaults
		WorkingMemoryCapacity:     8,
		WorkingMemoryDecayRate:    3,
		WorkingMemoryMinRelevance: 10,

		// Beam Search defaults
		BeamSearchWidth:                5,
		BeamSearchMaxCandidatesPerStep: 10,

		// Error-Driven Learning defaults
		ErrorLearningStrength:  5,
		ErrorLearningThreshold: 100,

		// Attention Module defaults
		AttentionHistorySize:    10,
		AttentionMinWeight:      64,
		AttentionContextBoost:   100,
		AttentionFrequencyScale: 25,

		// Analogy Engine defaults
		AnalogyMaxCandidates: 100,

		// Sleep Consolidation defaults
		SleepReplayCount:     10,
		SleepInterleaveRatio: 2,
		SleepStabilityThresh: 180,

		// Autonomous Learning defaults (previously hardcoded in constructor)
		AutoSeedTopics: []string{
			"photosynthesis", "DNA", "evolution", "gravity", "atom",
			"quantum mechanics", "relativity", "cell biology",
			"algebra", "geometry", "calculus", "probability",
			"prime number", "fibonacci sequence",
			"artificial intelligence", "neural network", "computer science",
			"algorithm", "machine learning", "programming language",
			"Roman Empire", "Renaissance", "World War II",
			"Ancient Egypt", "Industrial Revolution",
			"solar system", "continent", "ocean", "climate",
			"logic", "analogy", "metaphor", "reasoning",
			"România", "București", "Carpați", "Dunărea",
			"istoria României", "Mihai Eminescu",
		},
		AutoSeedDatasets: []string{
			"tatsu-lab/alpaca",
			"gsm8k",
			"hellaswag",
		},
		AutoSearchLangs:     []string{"en", "ro"},
		AutoHFRowsPerDS:     20,
		AutoLearnInterval:   30,
		AutoMaxGapsPerCycle: 3,

		// Web server defaults
		WebPort:     "8080",
		WebBindAddr: "127.0.0.1",

		// WebLearner defaults (previously hardcoded in web_learner.go)
		WebLearnerTimeoutSecs: 10,
		WebLearnerRateLimitMs: 2000,
		WebLearnerBodyLimitMB: 5,
		WebLearnerUserAgent:   "NexusCortex/1.0 (autonomous learner)",
		WebLearnerWikiBaseURL: "wikipedia.org",
		WebLearnerHFSearchURL: "https://huggingface.co/api/datasets",
		WebLearnerHFRowsURL:   "https://datasets-server.huggingface.co/rows",

		// WebGPU defaults
		WebGPUTimeoutSecs: 5,

		// Quantum-Inspired Engine defaults (disabled by default for backward compat)
		EnableQuantumInspired: false,
		QuantumTemperature:    0, // deterministic
		QuantumMultiSamples:   1, // no multi-sample

		// RadioCortex defaults
		RadioNeuronCount: 1_000_000, // 1M neurons (was hardcoded 100K)
		TrainingDataDir:  "./data/training",

		// SignalCodec defaults
		SignalCodecInitVocab:  1000,
		SignalCodecFreqsPerTk: 13,
		SignalCodecMaxFreqs:   64,

		// RadioCortex generation/training defaults
		RadioTrainAmplitude:      200,
		RadioResonanceThreshold:  20,
		RadioWeakNeuronThreshold: 32,
		RadioGenerateWindowSize:  8,
		RadioAntiLoopMaxRepeat:   2,
		RadioDecodeTopK:          5,

		// NeuroRadioCortex defaults
		NRCDecodeActiveThreshold: 5,
		NRCInitAmpMin:            100,
		NRCInitAmpRange:          155,
		NRCInhibitoryRatioDiv:    5,
		NRCInjectAmplitude:       200,

		// FractalCortex defaults
		FractalNumLayers:             24,
		FractalContextLen:            50,
		FractalTopK:                  3,
		FractalDecayRate:             64,
		FractalPerturbRate:           25,
		FractalNeurogenesisThreshold: 0.8,
		FractalMaxBlocks:             8,

		// Self-Training defaults
		SelfEvolveLearningRate: 0.0001,
		SelfEvolveBatchSize:    50,
		BPEMaxLinesPerFile:     10000,

		// Transformer defaults
		TransformerEmbedDim:  256,
		TransformerNumHeads:  4,
		TransformerNumLayers: 4,
		TransformerFFNDim:    1024,
		TransformerMaxSeqLen: 512,

		// Adam optimizer defaults (sensible pentru small transformers).
		// Pot fi suprascrise prin JSON config sau prin AdamConfig direct.
		AdamBeta1:       0.9,
		AdamBeta2:       0.999,
		AdamEpsilon:     1e-8,
		AdamMaxGradNorm: 1.0,

		// Chain-of-Thought / Self-Consistency defaults — opt-in, off
		// by default to keep current behaviour identical until the
		// operator explicitly turns it on.
		CoTEnabled:         false,
		CoTSamples:         3,
		CoTBaseTemperature: 0.8,
		CoTUsePrimer:       true,

		// Semantic Memory defaults
		SemanticMemorySimThreshold: 80,

		// Web Learner allowed domains
		WebLearnerAllowedDomains: []string{"huggingface.co", "datasets-server.huggingface.co", "wikipedia.org"},

		// Embedding defaults
		EmbeddingUnkTokenID: 1,

		// Autonomous learner defaults
		AutoLowConfThreshold: 100,

		// Master Bug Fix & Audit Verification defaults
		SelfEvaluatorPassThreshold:    0.3,
		FeedbackPositiveReward:        100,
		FeedbackNegativeReward:        -100,
		FeedbackNegativeArousal:       100,
		AutoLearnErrorBoost:           200,
		CorpusMinTextLen:              20,
		MemoryMinTextLen:              10,
		SemanticMemoryConceptMaturity: 10,
		SemanticMemoryMinViableBits:   5,
		AutoMaxGaps:                   1000,
		TransformerEOSTokenID:         3,
	}
}

// Validate checks the configuration for internal consistency.
// Returns an error if any constraints are violated.
func (c Config) Validate() error {
	// Dimensional constraints
	if c.SDRSize <= 0 || c.SDRSize > 1_000_000 {
		return fmt.Errorf("SDRSize must be in [1, 1000000], got %d", c.SDRSize)
	}
	if c.ActiveCount <= 0 || c.ActiveCount > c.SDRSize {
		return fmt.Errorf("ActiveCount must be in [1, SDRSize=%d], got %d", c.SDRSize, c.ActiveCount)
	}
	if c.MaxMemories <= 0 || c.MaxMemories > 10_000_000 {
		return fmt.Errorf("MaxMemories must be in [1, 10000000], got %d", c.MaxMemories)
	}
	if c.MaxGenWords < 0 || c.MaxGenWords > 10_000 {
		return fmt.Errorf("MaxGenWords must be in [0, 10000], got %d", c.MaxGenWords)
	}

	// Network/neuron constraints
	if c.PrefrontalNetSize <= 0 || c.PrefrontalNetSize > 1_000_000 {
		return fmt.Errorf("PrefrontalNetSize must be in [1, 1000000], got %d", c.PrefrontalNetSize)
	}
	if c.NeuronMinThreshold > c.NeuronMaxThreshold {
		return fmt.Errorf("NeuronMinThreshold (%d) > NeuronMaxThreshold (%d)", c.NeuronMinThreshold, c.NeuronMaxThreshold)
	}
	if c.NeuronMinLeak > c.NeuronMaxLeak {
		return fmt.Errorf("NeuronMinLeak (%d) > NeuronMaxLeak (%d)", c.NeuronMinLeak, c.NeuronMaxLeak)
	}
	if c.SynapseMinWeight > c.SynapseMaxWeight {
		return fmt.Errorf("SynapseMinWeight (%d) > SynapseMaxWeight (%d)", c.SynapseMinWeight, c.SynapseMaxWeight)
	}
	if c.SynapseMinDelay > c.SynapseMaxDelay {
		return fmt.Errorf("SynapseMinDelay (%d) > SynapseMaxDelay (%d)", c.SynapseMinDelay, c.SynapseMaxDelay)
	}
	if c.PredictorUnionDepth > c.PredictorWindowSize {
		return fmt.Errorf("PredictorUnionDepth (%d) > PredictorWindowSize (%d)", c.PredictorUnionDepth, c.PredictorWindowSize)
	}

	// Thousand Brains constraints
	if c.ThousandBrainsColumns <= 0 || c.ThousandBrainsColumns > 1000 {
		return fmt.Errorf("ThousandBrainsColumns must be in [1, 1000], got %d", c.ThousandBrainsColumns)
	}
	if c.ThousandBrainsColNeurons <= 0 || c.ThousandBrainsColNeurons > 10000 {
		return fmt.Errorf("ThousandBrainsColNeurons must be in [1, 10000], got %d", c.ThousandBrainsColNeurons)
	}
	if c.ThousandBrainsColConnectivity <= 0.0 || c.ThousandBrainsColConnectivity > 1.0 {
		return fmt.Errorf("ThousandBrainsColConnectivity must be in (0.0, 1.0], got %f", c.ThousandBrainsColConnectivity)
	}
	if c.ThousandBrainsProcessTicks <= 0 || c.ThousandBrainsProcessTicks > 100 {
		return fmt.Errorf("ThousandBrainsProcessTicks must be in [1, 100], got %d", c.ThousandBrainsProcessTicks)
	}

	// Prefrontal Reasoning constraints
	if c.PrefrontalConnectivity <= 0.0 || c.PrefrontalConnectivity > 1.0 {
		return fmt.Errorf("PrefrontalConnectivity must be in (0.0, 1.0], got %f", c.PrefrontalConnectivity)
	}
	if c.PrefrontalMaxHops <= 0 || c.PrefrontalMaxHops > 100 {
		return fmt.Errorf("PrefrontalMaxHops must be in [1, 100], got %d", c.PrefrontalMaxHops)
	}

	// Autonomous learner constraints
	if c.AutoHFRowsPerDS < 0 || c.AutoHFRowsPerDS > 100_000 {
		return fmt.Errorf("AutoHFRowsPerDS must be in [0, 100000], got %d", c.AutoHFRowsPerDS)
	}
	if c.AutoLearnInterval < 0 {
		return fmt.Errorf("AutoLearnInterval must be >= 0, got %d", c.AutoLearnInterval)
	}
	if c.AutoMaxGapsPerCycle < 0 {
		return fmt.Errorf("AutoMaxGapsPerCycle must be >= 0, got %d", c.AutoMaxGapsPerCycle)
	}

	// Web server constraints
	if c.WebBindAddr == "" {
		return fmt.Errorf("WebBindAddr cannot be empty")
	}
	if c.WebPort != "" {
		p, err := strconv.Atoi(c.WebPort)
		if err != nil || p < 1 || p > 65535 {
			return fmt.Errorf("WebPort must be a valid port [1-65535], got %q", c.WebPort)
		}
	}

	// WebLearner configuration constraints
	if c.WebLearnerTimeoutSecs <= 0 || c.WebLearnerTimeoutSecs > 120 {
		return fmt.Errorf("WebLearnerTimeoutSecs must be in [1, 120], got %d", c.WebLearnerTimeoutSecs)
	}
	if c.WebLearnerRateLimitMs < 0 || c.WebLearnerRateLimitMs > 60000 {
		return fmt.Errorf("WebLearnerRateLimitMs must be in [0, 60000], got %d", c.WebLearnerRateLimitMs)
	}
	if c.WebLearnerBodyLimitMB <= 0 || c.WebLearnerBodyLimitMB > 100 {
		return fmt.Errorf("WebLearnerBodyLimitMB must be in [1, 100], got %d", c.WebLearnerBodyLimitMB)
	}
	if c.WebLearnerWikiBaseURL == "" {
		return fmt.Errorf("WebLearnerWikiBaseURL cannot be empty")
	}
	if c.WebLearnerHFSearchURL == "" {
		return fmt.Errorf("WebLearnerHFSearchURL cannot be empty")
	}
	if c.WebLearnerHFRowsURL == "" {
		return fmt.Errorf("WebLearnerHFRowsURL cannot be empty")
	}
	if c.WebLearnerUserAgent == "" {
		return fmt.Errorf("WebLearnerUserAgent cannot be empty")
	}
	if c.WebGPUTimeoutSecs <= 0 || c.WebGPUTimeoutSecs > 120 {
		return fmt.Errorf("WebGPUTimeoutSecs must be in [1, 120], got %d", c.WebGPUTimeoutSecs)
	}

	// Memory capacity and queue limits
	if c.RewardSystemCapacity <= 0 || c.RewardSystemCapacity > 1_000_000 {
		return fmt.Errorf("RewardSystemCapacity must be in [1, 1000000], got %d", c.RewardSystemCapacity)
	}
	if c.EmotionHistoryCapacity <= 0 || c.EmotionHistoryCapacity > 1_000_000 {
		return fmt.Errorf("EmotionHistoryCapacity must be in [1, 1000000], got %d", c.EmotionHistoryCapacity)
	}
	if c.CuriosityHistoryCapacity <= 0 || c.CuriosityHistoryCapacity > 1_000_000 {
		return fmt.Errorf("CuriosityHistoryCapacity must be in [1, 1000000], got %d", c.CuriosityHistoryCapacity)
	}
	if c.SensoryBufferCapacity <= 0 || c.SensoryBufferCapacity > 1_000_000 {
		return fmt.Errorf("SensoryBufferCapacity must be in [1, 1000000], got %d", c.SensoryBufferCapacity)
	}
	if c.MotorQueueCapacity <= 0 || c.MotorQueueCapacity > 1_000_000 {
		return fmt.Errorf("MotorQueueCapacity must be in [1, 1000000], got %d", c.MotorQueueCapacity)
	}
	if c.MotorHistoryCapacity <= 0 || c.MotorHistoryCapacity > 1_000_000 {
		return fmt.Errorf("MotorHistoryCapacity must be in [1, 1000000], got %d", c.MotorHistoryCapacity)
	}
	if c.WorkspaceMaxQueueSize <= 0 || c.WorkspaceMaxQueueSize > 1_000_000 {
		return fmt.Errorf("WorkspaceMaxQueueSize must be in [1, 1000000], got %d", c.WorkspaceMaxQueueSize)
	}
	if c.WorkingMemoryCapacity <= 0 || c.WorkingMemoryCapacity > 1_000_000 {
		return fmt.Errorf("WorkingMemoryCapacity must be in [1, 1000000], got %d", c.WorkingMemoryCapacity)
	}
	if c.AttentionHistorySize <= 0 || c.AttentionHistorySize > 1_000_000 {
		return fmt.Errorf("AttentionHistorySize must be in [1, 1000000], got %d", c.AttentionHistorySize)
	}
	if c.AnalogyMaxCandidates <= 0 || c.AnalogyMaxCandidates > 1_000_000 {
		return fmt.Errorf("AnalogyMaxCandidates must be in [1, 1000000], got %d", c.AnalogyMaxCandidates)
	}
	if c.CerebellumMaxCacheSize <= 0 || c.CerebellumMaxCacheSize > 1_000_000 {
		return fmt.Errorf("CerebellumMaxCacheSize must be in [1, 1000000], got %d", c.CerebellumMaxCacheSize)
	}

	// Beam search constraints
	if c.BeamSearchWidth <= 0 || c.BeamSearchWidth > 100 {
		return fmt.Errorf("BeamSearchWidth must be in [1, 100], got %d", c.BeamSearchWidth)
	}

	// Quantum-Inspired Engine constraints
	if c.QuantumMultiSamples < 1 || c.QuantumMultiSamples > 16 {
		return fmt.Errorf("QuantumMultiSamples must be in [1, 16], got %d", c.QuantumMultiSamples)
	}

	// Master Bug Fix & Audit Verification validation
	if c.SelfEvaluatorPassThreshold < 0.0 || c.SelfEvaluatorPassThreshold > 1.0 {
		return fmt.Errorf("SelfEvaluatorPassThreshold must be in [0.0, 1.0], got %f", c.SelfEvaluatorPassThreshold)
	}
	if c.FeedbackPositiveReward < 0 {
		return fmt.Errorf("FeedbackPositiveReward must be in [0, 127], got %d", c.FeedbackPositiveReward)
	}
	if c.FeedbackNegativeReward > 0 {
		return fmt.Errorf("FeedbackNegativeReward must be in [-128, 0], got %d", c.FeedbackNegativeReward)
	}
	if c.CorpusMinTextLen <= 0 {
		return fmt.Errorf("CorpusMinTextLen must be > 0, got %d", c.CorpusMinTextLen)
	}
	if c.MemoryMinTextLen <= 0 {
		return fmt.Errorf("MemoryMinTextLen must be > 0, got %d", c.MemoryMinTextLen)
	}
	if c.SemanticMemoryConceptMaturity <= 0 {
		return fmt.Errorf("SemanticMemoryConceptMaturity must be > 0, got %d", c.SemanticMemoryConceptMaturity)
	}
	if c.SemanticMemoryMinViableBits <= 0 {
		return fmt.Errorf("SemanticMemoryMinViableBits must be > 0, got %d", c.SemanticMemoryMinViableBits)
	}
	if c.AutoMaxGaps <= 0 {
		return fmt.Errorf("AutoMaxGaps must be > 0, got %d", c.AutoMaxGaps)
	}
	if c.TransformerEOSTokenID < 0 {
		return fmt.Errorf("TransformerEOSTokenID must be >= 0, got %d", c.TransformerEOSTokenID)
	}

	// NeuroRadioCortex amplitude constraints — prevent uint8 overflow in neurogenesis.
	// InitAmpMin + InitAmpRange must fit in uint8 (0-255) so that
	// uint8(initAmpMin + rng.Intn(initAmpRange)) never truncates.
	if c.NRCInitAmpMin < 0 || c.NRCInitAmpMin > 255 {
		return fmt.Errorf("NRCInitAmpMin must be in [0, 255], got %d", c.NRCInitAmpMin)
	}
	if c.NRCInitAmpRange < 0 || c.NRCInitAmpRange > 255 {
		return fmt.Errorf("NRCInitAmpRange must be in [0, 255], got %d", c.NRCInitAmpRange)
	}
	if c.NRCInitAmpMin+c.NRCInitAmpRange > 255 {
		return fmt.Errorf("NRCInitAmpMin (%d) + NRCInitAmpRange (%d) = %d exceeds uint8 max 255",
			c.NRCInitAmpMin, c.NRCInitAmpRange, c.NRCInitAmpMin+c.NRCInitAmpRange)
	}

	return nil
}
