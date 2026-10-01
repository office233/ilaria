package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"swypik-os/core/devicesynth"
)

const maxProbeImageBytes = 2 << 20

type result struct {
	Accepted     bool                             `json:"accepted"`
	Error        string                           `json:"error,omitempty"`
	EntryRVA     uint64                           `json:"entry_rva"`
	ImageSpan    uint64                           `json:"image_span"`
	SegmentCount int                              `json:"segment_count"`
	TotalPages   uint32                           `json:"total_pages"`
	Segments     []devicesynth.DriverImageSegment `json:"segments"`
}

func readImage(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxProbeImageBytes {
		return nil, fmt.Errorf("probe image must be a regular file of at most %d bytes", maxProbeImageBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxProbeImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxProbeImageBytes {
		return nil, fmt.Errorf("probe image exceeds %d bytes", maxProbeImageBytes)
	}
	return data, nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go-probe IMAGE")
		os.Exit(2)
	}
	image, err := readImage(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	info, err := devicesynth.ParseDriverImageV1(image)
	out := result{Accepted: err == nil}
	if err != nil {
		out.Error = err.Error()
	} else {
		out.EntryRVA = info.EntryRVA
		out.ImageSpan = info.ImageSpan
		out.SegmentCount = len(info.Segments)
		out.TotalPages = info.TotalPages
		out.Segments = info.Segments
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
