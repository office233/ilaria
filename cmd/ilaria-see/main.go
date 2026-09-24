package main

// ilaria-see — end-to-end multimodal caption runner: SigLIP2-base vision
// tower + pixel shuffle + projector (cortex/vision_siglip.go) spliced into
// BitNet b1.58's input embeddings (cortex.BitNetDecoder.PrefillEmbeds,
// cortex/bitnet_decode.go, or -cuda's cortex.BitNetCUDADecoder.PrefillEmbeds,
// cortex/bitnet_cuda.go) via cortex.BitNetModel.EmbedTokens, greedy
// decoded with the KV-cached decoder — the Go-side counterpart to
// forge/multimodal/mm_model.py's BitNetVLM.generate_caption.
//
//	go run ./cmd/ilaria-see \
//	    -model data/forge/bitnet-2b4t/bitnet.nxtf \
//	    -tokenizer data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json \
//	    -tower data/forge/eyes/siglip2_base.nxtf \
//	    -adapter data/forge/eyes/projector_seed42 \
//	    -image data/forge/eyes/synthetic_shapes.png \
//	    -prompt "Describe the image briefly." -max-tokens 40
//
// -cuda (needs a -tags gpu build) runs the whole BitNet prefill+decode on
// the GPU via the NVRTC-compiled decoder (cmd/bitnet-run's -cuda backend):
// PrefillEmbeds uploads each of the header/image/tail embedding rows
// straight into the resident residual buffer (no per-row embedding-table
// lookup — see bitnet_cuda.go's uploadResidualRow) and every subsequent
// token is a resident-KV-cache Step, replacing the CPU prefill that takes
// minutes for a ~130-row multimodal sequence. Combinable with -gpu (which
// separately controls the vision tower's cuBLAS backend); -cuda takes
// precedence over -gpu's OWN int8-cuBLAS BitNet backend specifically (a
// known-buggy path at this row count — see cortex/bitnet_gpu.go), matching
// cmd/bitnet-run's -gpu/-cuda precedence exactly. On any CUDA construction
// error, a warning is printed and the run falls back to the CPU decoder.
//
// -adapter names an export_adapter.py PREFIX (PREFIX.safetensors +
// PREFIX.json — e.g. data/forge/eyes/projector_seed42, the fixed-seed
// random projector forge/multimodal/dump_vision_reference.py produces
// before a trained stage-1 checkpoint exists); if -adapter is a directory,
// "<dir>/projector_seed42" is tried as a convenience default.
//
// Prompt layout — mirrors BitNetVLM._prefix_embeds
// (forge/multimodal/mm_model.py) exactly:
//
//	full prompt text: "<image>\n{-prompt}"
//	split on the first "<image>" marker into (before, after)
//	header text: "User: " + before
//	tail text:   rstrip(after) + "<|eot_id|>Assistant: "
//	embeds:      EmbedTokens(header) ++ <121 image embeddings> ++ EmbedTokens(tail)
//
// -prompt has no "<image>" marker itself (it's the caption instruction,
// e.g. "Describe the image briefly."), so before is always "" and after is
// always "\n{-prompt}" — same as generate_caption's own default prompt
// "<image>\nDescribe the image briefly.". The assembled header/tail text
// is printed to stderr specifically so it can be diffed against Python's
// own `_split_prompt`/`_encode_text` output for the same -prompt string.
//
// Image decoding: cortex.DecodeImage (image/png + image/jpeg, standard
// library, registered by cortex/vision_siglip.go's blank imports).

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

const imageMarker = "<image>"

func main() {
	modelPath := flag.String("model", "", "Path to a BitNet NXTF v3 checkpoint (required)")
	tokenizerPath := flag.String("tokenizer", "", "Path to an HF tokenizer.json (required)")
	towerPath := flag.String("tower", "", "Path to a SigLIP2 vision tower NXTF v3 checkpoint (required, forge/multimodal/export_tower.py)")
	adapterPrefix := flag.String("adapter", "", "Prefix of a projector export (PREFIX.safetensors/.json, required)")
	imagePath := flag.String("image", "", "Path to a PNG/JPEG image (required)")
	prompt := flag.String("prompt", "Describe the image briefly.", "Caption instruction (the <image> marker is added automatically)")
	maxTokens := flag.Int("max-tokens", 40, "Max number of tokens to generate")
	maxTextLen := flag.Int("max-text-len", 256, "Per-segment token truncation, matching BitNetVLM(max_text_len=...) (mm_model.py)")
	gpuFlag := flag.Bool("gpu", false, "Route the vision tower's dense/attention matmuls through resident fp32 cuBLAS and (unless -cuda is also set) the BitNet prefill through the resident int8 cuBLAS backend (needs a -tags gpu build and CUDA; see cortex/vision_siglip_gpu.go and cortex/bitnet_gpu.go). Falls back to CPU with a warning if unavailable.")
	cudaFlag := flag.Bool("cuda", false, "Run the whole BitNet prefill+decode on the GPU via the NVRTC-compiled decoder (needs a -tags gpu build; see cortex/bitnet_cuda.go and cmd/bitnet-run's -cuda — takes precedence over -gpu's own int8-cuBLAS BitNet backend, not over -gpu's vision-tower backend). Falls back to CPU with a warning if unavailable.")
	flag.Parse()

	fail := func(stage string, err error) {
		fmt.Fprintf(os.Stderr, "error: %s: %v\n", stage, err)
		os.Exit(1)
	}
	if *modelPath == "" || *tokenizerPath == "" || *towerPath == "" || *adapterPrefix == "" || *imagePath == "" {
		fail("flags", fmt.Errorf("-model, -tokenizer, -tower, -adapter and -image are all required"))
	}

	// -adapter convenience: accept a directory and default to the
	// fixed-seed random projector's prefix inside it.
	if info, err := os.Stat(*adapterPrefix); err == nil && info.IsDir() {
		*adapterPrefix = filepath.Join(*adapterPrefix, "projector_seed42")
	}

	loadStart := time.Now()
	model, err := cortex.LoadBitNetModel(*modelPath)
	if err != nil {
		fail("model", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-see] loaded BitNet %s in %.2fs (vocab=%d layers=%d embed=%d)\n",
		*modelPath, time.Since(loadStart).Seconds(), model.Cfg.VocabSize, model.Cfg.NumLayers, model.Cfg.EmbedDim)

	tok, err := cortex.LoadHFTokenizerJSON(*tokenizerPath)
	if err != nil {
		fail("tokenizer", err)
	}

	towerStart := time.Now()
	tower, err := cortex.LoadSiglipVisionTower(*towerPath)
	if err != nil {
		fail("tower", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-see] loaded SigLIP2 tower %s in %.2fs (image_size=%d hidden=%d layers=%d)\n",
		*towerPath, time.Since(towerStart).Seconds(), tower.Cfg.ImageSize, tower.Cfg.Hidden, tower.Cfg.NumLayers)

	projector, err := cortex.LoadSiglipProjector(*adapterPrefix)
	if err != nil {
		fail("adapter", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-see] loaded projector %s (in=%d mlp=%d out=%d)\n",
		*adapterPrefix, projector.In, projector.Mlp, projector.Out)

	// -gpu: route the tower's dense/attention matmuls through resident
	// fp32 cuBLAS (cortex/vision_siglip_gpu.go) and the BitNet prefill
	// through the resident int8 cuBLAS backend (cortex/bitnet_gpu.go,
	// same one cmd/bitnet-run -gpu uses). Both failure modes are
	// non-fatal: a warning is printed and the run continues on the CPU
	// path for whichever half declined, matching every other GPU hook
	// in this codebase (a mid-run CUDA hiccup degrades speed, not
	// output).
	if *gpuFlag {
		towerGPUStart := time.Now()
		if err := cortex.EnableSiglipGPU(tower); err != nil {
			fmt.Fprintf(os.Stderr, "[ilaria-see] warning: vision GPU backend unavailable, tower stays on CPU: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[ilaria-see] vision GPU backend enabled in %.2fs\n", time.Since(towerGPUStart).Seconds())
		}

		// The int8 cuBLAS BitNet backend (bitnet_gpu.go) is a known bug at
		// this row count (see file doc comment) — -cuda's NVRTC decoder
		// supersedes it, so skip enabling it when -cuda is also set,
		// mirroring cmd/bitnet-run's `*gpu && !*cudaFlag` precedence.
		if !*cudaFlag {
			bitnetGPUStart := time.Now()
			if err := cortex.EnableBitNetGPU(model); err != nil {
				fmt.Fprintf(os.Stderr, "[ilaria-see] warning: BitNet GPU backend unavailable, prefill/decode stay on CPU: %v\n", err)
			} else {
				fmt.Fprintf(os.Stderr, "[ilaria-see] BitNet GPU backend enabled in %.2fs\n", time.Since(bitnetGPUStart).Seconds())
				if free, total, err := compute.MemInfoInt8(); err == nil {
					fmt.Fprintf(os.Stderr, "[ilaria-see] GPU memory: %.0f MiB used / %.0f MiB total\n",
						float64(total-free)/(1<<20), float64(total)/(1<<20))
				}
			}
		}
	}

	f, err := os.Open(*imagePath)
	if err != nil {
		fail("image", err)
	}
	img, format, err := cortex.DecodeImage(f)
	f.Close()
	if err != nil {
		fail("image decode", err)
	}
	fmt.Fprintf(os.Stderr, "[ilaria-see] decoded %s image %s\n", format, *imagePath)

	pixelValues := cortex.PreprocessImage(img, tower.Cfg.ImageSize)

	fwdStart := time.Now()
	hidden := tower.Forward(pixelValues)
	fwdElapsed := time.Since(fwdStart)
	gridSide := tower.Cfg.ImageSize / tower.Cfg.PatchSize
	shuffled := cortex.PixelShuffle(hidden, gridSide, 3)
	imgEmbeds := projector.Forward(shuffled)
	fmt.Fprintf(os.Stderr, "[ilaria-see] vision forward: tower=%s (%dx%d), %d image embeddings of dim %d\n",
		fwdElapsed, len(hidden), len(hidden[0]), len(imgEmbeds), len(imgEmbeds[0]))

	// Prompt layout — see file doc comment.
	fullPrompt := imageMarker + "\n" + *prompt
	before, after, ok := strings.Cut(fullPrompt, imageMarker)
	if !ok {
		fail("prompt", fmt.Errorf("internal error: %q lost its own image marker", fullPrompt))
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
	fmt.Fprintf(os.Stderr, "[ilaria-see] prefix text: header=%q image=<%d tokens> tail=%q\n", headerText, len(imgEmbeds), tailText)
	fmt.Fprintf(os.Stderr, "[ilaria-see] prefix ids: header=%v tail=%v\n", headerIDs, tailIDs)

	headerEmb := model.EmbedTokens(headerIDs)
	tailEmb := model.EmbedTokens(tailIDs)

	fullEmbeds := make([][]float32, 0, len(headerEmb)+len(imgEmbeds)+len(tailEmb))
	fullEmbeds = append(fullEmbeds, headerEmb...)
	fullEmbeds = append(fullEmbeds, imgEmbeds...)
	fullEmbeds = append(fullEmbeds, tailEmb...)

	stopSet := map[int]bool{model.Cfg.EOSTokenID: true}
	if eot := tok.EotID(); eot >= 0 {
		stopSet[eot] = true
	}

	// multimodalDecoder is the common PrefillEmbeds/Step/Len surface
	// *cortex.BitNetDecoder (CPU, always available) and
	// *cortex.BitNetCUDADecoder (GPU, -tags gpu) both satisfy — same
	// stepDecoder pattern cmd/bitnet-run uses for Prefill(ids).
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
			fmt.Fprintf(os.Stderr, "[ilaria-see] warning: CUDA decoder unavailable, prefill/decode fall back to CPU: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[ilaria-see] CUDA decoder ready (kernels compiled, weights uploaded) in %.2fs\n", time.Since(cudaStart).Seconds())
			if free, total, err := compute.DeviceMemInfo(); err == nil {
				fmt.Fprintf(os.Stderr, "[ilaria-see] GPU memory: %.0f MiB used / %.0f MiB total\n",
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
			// Device-side argmax kernel — see bitnet_cuda.go's Argmax,
			// same op cmd/bitnet-run's -cuda path would use.
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

	caption := tok.Decode(newIDs)
	fmt.Println(caption)

	rate := float64(len(newIDs)) / genElapsed.Seconds()
	fmt.Fprintf(os.Stderr, "[ilaria-see] prefill %d rows (%d text + %d image) in %.2fs | generated %d tokens in %.2fs (%.1f tok/s)\n",
		len(fullEmbeds), len(headerEmb)+len(tailEmb), len(imgEmbeds), prefillElapsed.Seconds(), len(newIDs), genElapsed.Seconds(), rate)
}
