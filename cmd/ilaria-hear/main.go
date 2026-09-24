package main

// ilaria-hear — end-to-end multimodal transcription-plumbing runner:
// Whisper-small encoder + stack_frames + audio projector
// (cortex/audio_whisper.go) spliced into BitNet b1.58's input embeddings
// (cortex.BitNetDecoder.PrefillEmbeds, cortex/bitnet_decode.go, or
// -cuda's cortex.BitNetCUDADecoder.PrefillEmbeds, cortex/bitnet_cuda.go)
// via cortex.BitNetModel.EmbedTokens, greedy decoded with the KV-cached
// decoder — the "ears" counterpart to cmd/ilaria-see, mirroring its
// structure line for line wherever the audio modality allows the same
// shape.
//
//	go run ./cmd/ilaria-hear \
//	    -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -tower data/forge/ears/whisper_small_encoder.nxtf \
//	    -adapter data/forge/ears/projector_seed42 \
//	    -wav data/forge/ears/test_tone.wav \
//	    -prompt "Transcribe the audio." -max-tokens 40
//
// -adapter is OPTIONAL, unlike cmd/ilaria-see's (required) -adapter: no
// stage-1 audio projector has been trained yet (only a random-weights
// fixture round-tripped through the export format exists — see
// forge/multimodal/dump_audio_reference.py's projector_seed42* output),
// so end-to-end decoded text CANNOT be validated for meaning here. When
// -adapter (and -model/-tokenizer) are omitted, this command stops right
// after the tower forward + stack_frames step and prints the stacked
// token count and timing — validating the log-mel front end, the
// encoder, real_frame_count cropping, and StackFrames shape, without
// needing a BitNet checkpoint at all. When -adapter IS given (with
// -model/-tokenizer), the full splice+decode plumbing runs too, but the
// generated text is only a plumbing smoke test, not a meaningful
// transcript: the projector's weights are untrained (random, unless a
// real forge/multimodal/train_stage1_audio.py checkpoint has been
// exported), so the decoder has no reason to produce anything
// audio-relevant. -cuda is symmetric with cmd/ilaria-see's own -cuda
// (same decoder types, same fallback-to-CPU-with-a-warning behavior).
// -gpu routes the Whisper tower's OWN matmuls (conv1d/q/k/v/o/fc1/fc2 +
// attention) through the resident fp32 cuBLAS backend
// (cortex/audio_whisper_gpu.go, EnableWhisperGPU/DisableWhisperGPU) —
// the "ears" analogue of cmd/ilaria-see's vision-tower -gpu; same
// fallback-to-CPU-with-a-warning behavior, and freely combinable with
// -cuda (they gate independent halves of the pipeline: -gpu the tower
// forward, -cuda the BitNet prefill/decode), matching cmd/ilaria-see's
// own `-gpu -cuda` combination.
//
// -adapter names an export_audio_adapter.py PREFIX (PREFIX.safetensors +
// PREFIX.json — e.g. data/forge/ears/projector_seed42, the fixed-seed
// random projector forge/multimodal/dump_audio_reference.py produces
// before a trained stage-1 audio checkpoint exists); if -adapter is a
// directory, "<dir>/projector_seed42" is tried as a convenience default,
// mirroring cmd/ilaria-see's own -adapter directory convenience.
//
// Prompt layout — mirrors BitNetVLM._prefix_embeds
// (forge/multimodal/mm_model.py) with placeholder=AUDIO_PLACEHOLDER
// ("<audio>") exactly, same as cmd/ilaria-see's own doc comment for the
// vision ("<image>") case:
//
//	full prompt text: "<audio>\n{-prompt}"
//	split on the first "<audio>" marker into (before, after)
//	header text: "User: " + before
//	tail text:   rstrip(after) + "<|eot_id|>Assistant: "
//	embeds:      EmbedTokens(header) ++ <N audio embeddings> ++ EmbedTokens(tail)
//
// -prompt has no "<audio>" marker itself (it's the transcription
// instruction, e.g. "Transcribe the audio."), so before is always "" and
// after is always "\n{-prompt}" — same as
// AudioAdapter/BitNetVLM.generate_from_features's own default prompt
// f"{AUDIO_PLACEHOLDER}\nTranscribe the audio." (see
// forge/multimodal/tests/test_audio_adapter.py's own usage). The
// assembled header/tail text is printed to stderr specifically so it can
// be diffed against Python's own `_split_prompt`/`_encode_text` output
// for the same -prompt string.
//
// Audio decoding: cortex.DecodeWAV (cortex/audio_wav.go — 16-bit PCM or
// 32-bit float WAV, any channel count downmixed to mono).

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	cortex "nexus-cortex/cortex"
	"nexus-cortex/cortex/compute"
)

const audioMarker = "<audio>"

// stackFactor is AudioAdapterConfig's default stack_factor (forge/
// multimodal/audio_adapter.py) — the number of consecutive encoder
// frames StackFrames concatenates into one token. Not exposed as a flag:
// every export this command reads (tower + projector) is built for this
// exact value, and a mismatched stack_factor would silently produce the
// wrong-width tokens for the projector's In dimension (which
// cortex.LoadAudioProjector checks against downstream anyway, so a
// mismatch here would fail loudly at the projector.Forward step, not
// worse).
const stackFactor = 8

func main() {
	towerPath := flag.String("tower", "", "Path to a Whisper encoder NXTF v3 checkpoint (required, forge/multimodal/export_whisper_tower.py)")
	wavPath := flag.String("wav", "", "Path to a 16-bit PCM or 32-bit float WAV file (required)")
	adapterPrefix := flag.String("adapter", "", "Prefix of a projector export (PREFIX.safetensors/.json); if omitted, stops after the tower forward + stack_frames step and prints the stacked token count")
	modelPath := flag.String("model", "", "Path to a BitNet NXTF v3 checkpoint (required if -adapter is set)")
	tokenizerPath := flag.String("tokenizer", "", "Path to an HF tokenizer.json (required if -adapter is set)")
	prompt := flag.String("prompt", "Transcribe the audio.", "Instruction (the <audio> marker is added automatically)")
	maxTokens := flag.Int("max-tokens", 40, "Max number of tokens to generate")
	maxTextLen := flag.Int("max-text-len", 256, "Per-segment token truncation, matching BitNetVLM(max_text_len=...) (mm_model.py)")
	cudaFlag := flag.Bool("cuda", false, "Run the whole BitNet prefill+decode on the GPU via the NVRTC-compiled decoder (needs a -tags gpu build; see cortex/bitnet_cuda.go and cmd/bitnet-run's -cuda). Falls back to CPU with a warning if unavailable.")
	gpuFlag := flag.Bool("gpu", false, "Route the Whisper tower's dense/attention matmuls through resident fp32 cuBLAS (needs a -tags gpu build; see cortex/audio_whisper_gpu.go and cmd/ilaria-see's -gpu). Falls back to CPU with a warning if unavailable. Combinable with -cuda.")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}
	if *towerPath == "" || *wavPath == "" {
		fail("flags", fmt.Errorf("-tower and -wav are required"))
	}
	decodeRequested := *adapterPrefix != ""
	if decodeRequested && (*modelPath == "" || *tokenizerPath == "") {
		fail("flags", fmt.Errorf("-model and -tokenizer are required when -adapter is set"))
	}

	// -adapter convenience: accept a directory and default to the
	// fixed-seed random projector's prefix inside it — mirrors
	// cmd/ilaria-see's own -adapter directory convenience.
	if decodeRequested {
		if info, err := os.Stat(*adapterPrefix); err == nil && info.IsDir() {
			*adapterPrefix = filepath.Join(*adapterPrefix, "projector_seed42")
		}
	}

	towerStart := time.Now()
	tower, err := cortex.LoadWhisperEncoderTower(*towerPath)
	if err != nil {
		fail("tower", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-hear] loaded Whisper encoder %s in %.2fs (mel_bins=%d hidden=%d layers=%d max_source_positions=%d)\n",
		*towerPath, time.Since(towerStart).Seconds(), tower.Cfg.NumMelBins, tower.Cfg.Hidden, tower.Cfg.NumLayers, tower.Cfg.MaxSourcePositions)

	// -gpu: route the tower's dense/attention matmuls through resident
	// fp32 cuBLAS (cortex/audio_whisper_gpu.go). Non-fatal on failure: a
	// warning is printed and the run continues on the CPU path, matching
	// every other GPU hook in this codebase (a mid-run CUDA hiccup
	// degrades speed, not output) — same pattern as cmd/ilaria-see's
	// -gpu.
	if *gpuFlag {
		towerGPUStart := time.Now()
		if err := cortex.EnableWhisperGPU(tower); err != nil {
			fmt.Fprintf(os.Stderr, "[ilaria-hear] warning: audio GPU backend unavailable, tower stays on CPU: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[ilaria-hear] audio GPU backend enabled in %.2fs\n", time.Since(towerGPUStart).Seconds())
			if free, total, err := compute.DeviceMemInfo(); err == nil {
				fmt.Fprintf(os.Stderr, "[ilaria-hear] GPU memory: %.0f MiB used / %.0f MiB total\n",
					float64(total-free)/(1<<20), float64(total)/(1<<20))
			}
		}
	}

	wf, err := os.Open(*wavPath)
	if err != nil {
		fail("wav", err)
	}
	samples, sampleRate, err := cortex.DecodeWAV(wf)
	wf.Close()
	if err != nil {
		fail("wav decode", err)
	}
	if sampleRate != tower.Cfg.SamplingRate {
		fail("wav", fmt.Errorf("wav sample rate %d Hz, tower expects %d Hz", sampleRate, tower.Cfg.SamplingRate))
	}
	fmt.Fprintf(os.Stderr, "[ilaria-hear] decoded %s: %d samples @ %d Hz (%.2fs)\n",
		*wavPath, len(samples), sampleRate, float64(len(samples))/float64(sampleRate))

	logMelStart := time.Now()
	logMel := tower.LogMel(samples)
	logMelElapsed := time.Since(logMelStart)

	fwdStart := time.Now()
	hidden := tower.Forward(logMel)
	fwdElapsed := time.Since(fwdStart)

	realFrames := cortex.RealFrameCount(len(samples), sampleRate, tower.Cfg.MaxSourcePositions)
	cropped := hidden[:realFrames]
	stacked := cortex.StackFrames(cropped, stackFactor)
	fmt.Fprintf(os.Stderr, "[ilaria-hear] log-mel %s (%dx%d), tower forward %s (%dx%d), real_frames=%d, stacked %d tokens of dim %d\n",
		logMelElapsed, len(logMel), len(logMel[0]), fwdElapsed, len(hidden), len(hidden[0]), realFrames, len(stacked), len(stacked[0]))

	if !decodeRequested {
		fmt.Printf("stacked_tokens=%d token_dim=%d real_frames=%d tower_forward=%s\n",
			len(stacked), len(stacked[0]), realFrames, fwdElapsed)
		fmt.Fprintln(os.Stderr, "[ilaria-hear] no -adapter given — stopping after stack_frames (no trained projector to splice into a decode yet)")
		return
	}

	projector, err := cortex.LoadAudioProjector(*adapterPrefix)
	if err != nil {
		fail("adapter", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-hear] loaded projector %s (in=%d mlp=%d out=%d) — UNTRAINED unless this is a real stage-1 checkpoint export; decoded text below is a plumbing check only, not a real transcript\n",
		*adapterPrefix, projector.In, projector.Mlp, projector.Out)

	audioEmbeds := projector.Forward(stacked)

	loadStart := time.Now()
	model, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		fail("model", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-hear] loaded BitNet %s in %.2fs (vocab=%d layers=%d embed=%d)\n",
		*modelPath, time.Since(loadStart).Seconds(), model.Cfg.VocabSize, model.Cfg.NumLayers, model.Cfg.EmbedDim)

	tok, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
	if err != nil {
		fail("tokenizer", err)
	}

	// Prompt layout — see file doc comment.
	fullPrompt := audioMarker + "\n" + *prompt
	before, after, ok := strings.Cut(fullPrompt, audioMarker)
	if !ok {
		fail("prompt", fmt.Errorf("internal error: %q lost its own audio marker", fullPrompt))
	}
	headerText := "User: " + before
	tailText := strings.TrimRightFunc(after, unicode.IsSpace) + "<|eot_id|>Assistant: "

	headerIDs := tok.Encode(headerText)
	if len(headerIDs) > *maxTextLen {
		headerIDs = headerIDs[:*maxTextLen]
	}
	tailIDs := tok.Encode(tailText)
	if len(tailIDs) > *maxTextLen {
		tailIDs = tailIDs[:*maxTextLen]
	}
	fmt.Fprintf(os.Stderr, "[ilaria-hear] prefix text: header=%q audio=<%d tokens> tail=%q\n", headerText, len(audioEmbeds), tailText)
	fmt.Fprintf(os.Stderr, "[ilaria-hear] prefix ids: header=%v tail=%v\n", headerIDs, tailIDs)

	headerEmb := model.EmbedTokens(headerIDs)
	tailEmb := model.EmbedTokens(tailIDs)

	fullEmbeds := make([][]float32, 0, len(headerEmb)+len(audioEmbeds)+len(tailEmb))
	fullEmbeds = append(fullEmbeds, headerEmb...)
	fullEmbeds = append(fullEmbeds, audioEmbeds...)
	fullEmbeds = append(fullEmbeds, tailEmb...)

	stopSet := map[int]bool{model.Cfg.EOSTokenID: true}
	if eot := tok.EotID(); eot >= 0 {
		stopSet[eot] = true
	}

	// multimodalDecoder is the common PrefillEmbeds/Step/Len surface
	// *cortex.BitNetDecoder (CPU, always available) and
	// *cortex.BitNetCUDADecoder (GPU, -tags gpu) both satisfy — same
	// pattern cmd/ilaria-see uses.
	type multimodalDecoder interface {
		PrefillEmbeds(embeds [][]float32) []float32
		Step(id int) []float32
		Len() int
	}

	var dec multimodalDecoder
	var cudaDec *cortex.BitNetCUDADecoder // non-nil only when the -cuda decoder is in use, for its device-side Argmax()
	if *cudaFlag {
		cudaStart := time.Now()
		cd, err := cortex.NewBitNetCUDADecoder(model)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[ilaria-hear] warning: CUDA decoder unavailable, prefill/decode fall back to CPU: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[ilaria-hear] CUDA decoder ready (kernels compiled, weights uploaded) in %.2fs\n", time.Since(cudaStart).Seconds())
			if free, total, err := compute.DeviceMemInfo(); err == nil {
				fmt.Fprintf(os.Stderr, "[ilaria-hear] GPU memory: %.0f MiB used / %.0f MiB total\n",
					float64(total-free)/(1<<20), float64(total)/(1<<20))
			}
			defer cd.Close()
			dec = cd
			cudaDec = cd
		}
	}
	if dec == nil {
		dec = cortex.NewBitNetDecoder(model)
	}

	prefillStart := time.Now()
	logits := dec.PrefillEmbeds(fullEmbeds)
	prefillElapsed := time.Since(prefillStart)

	var newIDs []int
	genStart := time.Now()
	for i := 0; i < *maxTokens; i++ {
		var best int
		if cudaDec != nil {
			best = cudaDec.Argmax()
		} else {
			best = 0
			bestVal := logits[0]
			for v := 1; v < len(logits); v++ {
				if logits[v] > bestVal {
					bestVal = logits[v]
					best = v
				}
			}
		}
		newIDs = append(newIDs, best)
		if stopSet[best] {
			break
		}
		if i == *maxTokens-1 || dec.Len() >= model.Cfg.MaxSeqLen {
			break
		}
		logits = dec.Step(best)
	}
	genElapsed := time.Since(genStart)

	transcript := tok.Decode(newIDs)
	fmt.Println(transcript)

	rate := float64(len(newIDs)) / genElapsed.Seconds()
	fmt.Fprintf(os.Stderr, "[ilaria-hear] prefill %d rows (%d text + %d audio) in %.2fs | generated %d tokens in %.2fs (%.1f tok/s)\n",
		len(fullEmbeds), len(headerEmb)+len(tailEmb), len(audioEmbeds), prefillElapsed.Seconds(), len(newIDs), genElapsed.Seconds(), rate)
}
