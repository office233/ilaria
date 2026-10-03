package devicesynth

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	DriverImageHeaderBytes  = 64
	DriverImageSegmentBytes = 48
	DriverImageMaxSegments  = 8
	DriverImageMaxPages     = 256
	DriverImageMaxSpan      = 0x10000000
	DriverImagePageSize     = 4096
)

const (
	DriverImageSegmentRead uint64 = 1 << iota
	DriverImageSegmentWrite
	DriverImageSegmentExecute
)

var driverImageMagicV1 = [8]byte{'S', 'W', 'Y', 'D', 'R', 'V', '1', 0}

type DriverImageSegment struct {
	VirtualOffset uint64 `json:"virtual_offset"`
	FileOffset    uint64 `json:"file_offset"`
	FileSize      uint64 `json:"file_size"`
	MemorySize    uint64 `json:"memory_size"`
	Flags         uint64 `json:"flags"`
}

type DriverImageInfo struct {
	EntryRVA   uint64               `json:"entry_rva"`
	ImageSpan  uint64               `json:"image_span"`
	TotalPages uint32               `json:"total_pages"`
	Segments   []DriverImageSegment `json:"segments"`
}

func driverImageRange(offset, size, total uint64) bool {
	return offset <= total && size <= total-offset
}

func driverImagePageAligned(v uint64) bool { return v&(DriverImagePageSize-1) == 0 }

func driverImageSegmentsOverlap(a, b DriverImageSegment) bool {
	return a.VirtualOffset < b.VirtualOffset+b.MemorySize && b.VirtualOffset < a.VirtualOffset+a.MemorySize
}

// ParseDriverImageV1 validates the byte-defined executable container accepted
// by the x86_64 kernel loader. V1 is position-fixed, import/relocation-free and
// requires readable, page-aligned, non-overlapping W^X segments.
func ParseDriverImageV1(image []byte) (DriverImageInfo, error) {
	var info DriverImageInfo
	if len(image) < DriverImageHeaderBytes {
		return info, errors.New("driver image header is truncated")
	}
	for i := range driverImageMagicV1 {
		if image[i] != driverImageMagicV1[i] {
			return info, errors.New("driver image magic mismatch")
		}
	}
	version := binary.LittleEndian.Uint16(image[8:10])
	headerBytes := binary.LittleEndian.Uint16(image[10:12])
	segmentCount := binary.LittleEndian.Uint16(image[12:14])
	reserved16 := binary.LittleEndian.Uint16(image[14:16])
	headerFlags := binary.LittleEndian.Uint32(image[16:20])
	reserved32 := binary.LittleEndian.Uint32(image[20:24])
	entryRVA := binary.LittleEndian.Uint64(image[24:32])
	imageSpan := binary.LittleEndian.Uint64(image[32:40])
	if version != 1 || headerBytes != DriverImageHeaderBytes || segmentCount == 0 || segmentCount > DriverImageMaxSegments ||
		reserved16 != 0 || headerFlags != 0 || reserved32 != 0 || binary.LittleEndian.Uint64(image[40:48]) != 0 ||
		binary.LittleEndian.Uint64(image[48:56]) != 0 || binary.LittleEndian.Uint64(image[56:64]) != 0 ||
		imageSpan == 0 || imageSpan > DriverImageMaxSpan || !driverImagePageAligned(imageSpan) || entryRVA >= imageSpan {
		return info, errors.New("driver image header is non-canonical")
	}
	descriptorBytes := uint64(segmentCount) * DriverImageSegmentBytes
	if !driverImageRange(uint64(headerBytes), descriptorBytes, uint64(len(image))) {
		return info, errors.New("driver image segment table is truncated")
	}

	info.EntryRVA = entryRVA
	info.ImageSpan = imageSpan
	info.Segments = make([]DriverImageSegment, 0, segmentCount)
	var totalPages uint64
	entryExecutable := false
	for i := uint16(0); i < segmentCount; i++ {
		off := uint64(headerBytes) + uint64(i)*DriverImageSegmentBytes
		raw := image[off : off+DriverImageSegmentBytes]
		segment := DriverImageSegment{
			VirtualOffset: binary.LittleEndian.Uint64(raw[0:8]),
			FileOffset:    binary.LittleEndian.Uint64(raw[8:16]),
			FileSize:      binary.LittleEndian.Uint64(raw[16:24]),
			MemorySize:    binary.LittleEndian.Uint64(raw[24:32]),
			Flags:         binary.LittleEndian.Uint64(raw[32:40]),
		}
		if binary.LittleEndian.Uint64(raw[40:48]) != 0 || segment.MemorySize == 0 ||
			!driverImagePageAligned(segment.VirtualOffset) || !driverImagePageAligned(segment.MemorySize) ||
			segment.MemorySize > imageSpan || segment.VirtualOffset > imageSpan-segment.MemorySize ||
			segment.FileSize > segment.MemorySize || !driverImageRange(segment.FileOffset, segment.FileSize, uint64(len(image))) ||
			segment.Flags&DriverImageSegmentRead == 0 ||
			segment.Flags&^(DriverImageSegmentRead|DriverImageSegmentWrite|DriverImageSegmentExecute) != 0 ||
			segment.Flags&DriverImageSegmentWrite != 0 && segment.Flags&DriverImageSegmentExecute != 0 {
			return DriverImageInfo{}, fmt.Errorf("driver image segment %d is invalid", i)
		}
		if segment.FileSize != 0 && segment.FileOffset < uint64(headerBytes)+descriptorBytes {
			return DriverImageInfo{}, fmt.Errorf("driver image segment %d overlaps metadata", i)
		}
		for j, previous := range info.Segments {
			if driverImageSegmentsOverlap(previous, segment) {
				return DriverImageInfo{}, fmt.Errorf("driver image segment %d overlaps segment %d", i, j)
			}
		}
		pages := segment.MemorySize / DriverImagePageSize
		totalPages += pages
		if totalPages > DriverImageMaxPages {
			return DriverImageInfo{}, errors.New("driver image page budget exceeded")
		}
		if segment.Flags&DriverImageSegmentExecute != 0 && entryRVA >= segment.VirtualOffset && entryRVA < segment.VirtualOffset+segment.MemorySize {
			entryExecutable = true
		}
		info.Segments = append(info.Segments, segment)
	}
	if !entryExecutable || totalPages == 0 {
		return DriverImageInfo{}, errors.New("driver image entrypoint is not inside an executable segment")
	}
	info.TotalPages = uint32(totalPages)
	return info, nil
}
