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
// -video (needs ffmpeg + ffprobe on PATH or -ffmpeg/-ffprobe) is the
// "video via frames" mode the study settled on: -frames evenly spaced
// frames are pulled out of the file (ffprobe for the duration, one
// ffmpeg -ss seek per frame, JPEG over a pipe — no temp files), each is
// captioned exactly like -image (same tower/projector/prompt, decoder
// Reset between frames), and the numbered captions are then fed back to
// the cortex as a plain text chat turn (-video-prompt) whose answer is
// the video description. The stage-1 projector was trained on single
// images, so the frames are NOT spliced into one prompt (out of
// distribution for it); the frame captions + a text summary is what
// today's weights honestly support. Each frame caption is printed as
// "frame i (t s): ..." and the summary as "video: ...".
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
	"bytes"
	"flag"
	"fmt"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	imagePath := flag.String("image", "", "Path to a PNG/JPEG image (required unless -video)")
	videoPath := flag.String("video", "", "Path to a video file: caption -frames evenly spaced frames, then summarise them (needs ffmpeg/ffprobe; see doc comment)")
	numFrames := flag.Int("frames", 6, "-video: number of evenly spaced frames to caption")
	videoPrompt := flag.String("video-prompt", "Describe what happens in the video in one or two sentences.", "-video: instruction appended after the numbered frame captions in the text-only summary turn")
	ffmpegPath := flag.String("ffmpeg", "ffmpeg", "-video: ffmpeg executable")
	ffprobePath := flag.String("ffprobe", "ffprobe", "-video: ffprobe executable (duration)")
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
	if *modelPath == "" || *tokenizerPath == "" || *towerPath == "" || *adapterPrefix == "" || (*imagePath == "" && *videoPath == "") {
		fail("flags", fmt.Errorf("-model, -tokenizer, -tower, -adapter and one of -image / -video are required"))
	}
	if *imagePath != "" && *videoPath != "" {
		fail("flags", fmt.Errorf("-image and -video are mutually exclusive"))
	}
	if *numFrames < 1 {
		fail("flags", fmt.Errorf("-frames must be >= 1"))
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

	// multimodalDecoder is the common Prefill/PrefillEmbeds/Step/Len/Reset
	// surface *cortex.BitNetDecoder (CPU, always available) and
	// *cortex.BitNetCUDADecoder (GPU, -tags gpu) both satisfy — same
	// stepDecoder pattern cmd/bitnet-run uses for Prefill(ids). Reset lets
	// -video reuse one decoder (and one resident weight set) across frames.
	type multimodalDecoder interface {
		Prefill(ids []int) []float32
		PrefillEmbeds(embeds [][]float32) []float32
		Step(id int) []float32
		Len() int
		Reset()
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

	stopSet := map[int]bool{model.Cfg.EOSTokenID: true}
	if eot := tok.EotID(); eot >= 0 {
		stopSet[eot] = true
	}

	// greedy continues from the logits of the last prefilled position:
	// argmax (device-side on the CUDA decoder), stop on eos/eot,
	// -max-tokens or the cache limit.
	greedy := func(logits []float32) []int {
		var newIDs []int
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
		return newIDs
	}

	// captionImage runs one image through tower → pixel shuffle →
	// projector, splices it into the chat prompt (layout in the file doc
	// comment) and greedy-decodes the answer on a freshly Reset decoder.
	captionImage := func(img image.Image, instruction string) (string, captionStats) {
		var st captionStats
		pixelValues := cortex.PreprocessImage(img, tower.Cfg.ImageSize)

		fwdStart := time.Now()
		hidden := tower.Forward(pixelValues)
		st.tower = time.Since(fwdStart)
		gridSide := tower.Cfg.ImageSize / tower.Cfg.PatchSize
		shuffled := cortex.PixelShuffle(hidden, gridSide, 3)
		imgEmbeds := projector.Forward(shuffled)
		fmt.Fprintf(os.Stderr, "[ilaria-see] vision forward: tower=%s (%dx%d), %d image embeddings of dim %d\n",
			st.tower, len(hidden), len(hidden[0]), len(imgEmbeds), len(imgEmbeds[0]))

		fullPrompt := imageMarker + "\n" + instruction
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
		st.rows, st.textRows, st.imageRows = len(fullEmbeds), len(headerEmb)+len(tailEmb), len(imgEmbeds)

		dec.Reset()
		prefillStart := time.Now()
		logits := dec.PrefillEmbeds(fullEmbeds)
		st.prefill = time.Since(prefillStart)

		genStart := time.Now()
		newIDs := greedy(logits)
		st.gen = time.Since(genStart)
		st.tokens = len(newIDs)
		return tok.Decode(newIDs), st
	}

	if *videoPath != "" {
		frames, stamps, err := extractFrames(*ffmpegPath, *ffprobePath, *videoPath, *numFrames)
		if err != nil {
			fail("video", err)
		}
		fmt.Fprintf(os.Stderr, "[ilaria-see] %s: %d frames at %v\n", *videoPath, len(frames), stamps)
		captions := make([]string, 0, len(frames))
		for i, img := range frames {
			caption, st := captionImage(img, *prompt)
			caption = strings.TrimSpace(caption)
			captions = append(captions, caption)
			fmt.Printf("frame %d (%.1fs): %s\n", i+1, stamps[i], caption)
			fmt.Fprintf(os.Stderr, "[ilaria-see] frame %d: tower %s | prefill %d rows in %.2fs | %d tokens in %.2fs\n",
				i+1, st.tower, st.rows, st.prefill.Seconds(), st.tokens, st.gen.Seconds())
		}

		// Text-only summary turn through the same decoder/tokenizer:
		// "User: {numbered captions + -video-prompt}<|eot_id|>Assistant: ".
		var sb strings.Builder
		fmt.Fprintf(&sb, "These are captions of %d frames sampled in order from a video:\n", len(captions))
		for i, c := range captions {
			fmt.Fprintf(&sb, "%d. %s\n", i+1, c)
		}
		sb.WriteString(*videoPrompt)
		ids := tok.Encode("User: " + sb.String() + "<|eot_id|>Assistant: ")
		dec.Reset()
		prefillStart := time.Now()
		logits := dec.Prefill(ids)
		prefillElapsed := time.Since(prefillStart)
		genStart := time.Now()
		newIDs := greedy(logits)
		genElapsed := time.Since(genStart)
		fmt.Println("video: " + strings.TrimSpace(tok.Decode(newIDs)))
		fmt.Fprintf(os.Stderr, "[ilaria-see] summary: prefill %d text tokens in %.2fs | generated %d tokens in %.2fs (%.1f tok/s)\n",
			len(ids), prefillElapsed.Seconds(), len(newIDs), genElapsed.Seconds(), float64(len(newIDs))/genElapsed.Seconds())
		return
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

	caption, st := captionImage(img, *prompt)
	fmt.Println(caption)
	fmt.Fprintf(os.Stderr, "[ilaria-see] prefill %d rows (%d text + %d image) in %.2fs | generated %d tokens in %.2fs (%.1f tok/s)\n",
		st.rows, st.textRows, st.imageRows, st.prefill.Seconds(), st.tokens, st.gen.Seconds(), float64(st.tokens)/st.gen.Seconds())
}

// captionStats is what captionImage measures for one image.
type captionStats struct {
	tower, prefill, gen       time.Duration
	rows, textRows, imageRows int
	tokens                    int
}

// extractFrames pulls n evenly spaced frames out of a video: ffprobe for
// the duration, then one accurate `ffmpeg -ss t -i file -frames:v 1` seek
// per frame at t_i = (i+0.5)·D/n, JPEG-encoded over stdout (image2pipe,
// no temp files) and decoded with cortex.DecodeImage. Returns the frames
// and their timestamps in seconds.
func extractFrames(ffmpeg, ffprobe, path string, n int) ([]image.Image, []float64, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, nil, err
	}
	out, err := exec.Command(ffprobe, "-v", "error", "-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		return nil, nil, fmt.Errorf("ffprobe %s: %w", path, err)
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil || duration <= 0 {
		return nil, nil, fmt.Errorf("ffprobe %s: bad duration %q", path, strings.TrimSpace(string(out)))
	}
	frames := make([]image.Image, 0, n)
	stamps := make([]float64, 0, n)
	for i := 0; i < n; i++ {
		t := (float64(i) + 0.5) * duration / float64(n)
		var stderr bytes.Buffer
		cmd := exec.Command(ffmpeg, "-v", "error", "-ss", strconv.FormatFloat(t, 'f', 3, 64), "-i", path,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "pipe:1")
		cmd.Stderr = &stderr
		jpg, err := cmd.Output()
		if err != nil {
			return nil, nil, fmt.Errorf("ffmpeg frame %d @ %.3fs: %w: %s", i+1, t, err, strings.TrimSpace(stderr.String()))
		}
		if len(jpg) == 0 {
			return nil, nil, fmt.Errorf("ffmpeg frame %d @ %.3fs: no image data (past the last frame?)", i+1, t)
		}
		img, _, err := cortex.DecodeImage(bytes.NewReader(jpg))
		if err != nil {
			return nil, nil, fmt.Errorf("decode frame %d @ %.3fs: %w", i+1, t, err)
		}
		frames = append(frames, img)
		stamps = append(stamps, t)
	}
	return frames, stamps, nil
}
