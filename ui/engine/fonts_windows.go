//go:build windows

package engine

import (
	"embed"
	"unsafe"
)

// Plus Jakarta Sans is the Swypik typeface (SIL Open Font License, see
// fonts/OFL.txt). It is embedded so every install renders identically; the
// fonts are private to this process and never installed system-wide.
//
//go:embed fonts/*.ttf
var fontFiles embed.FS

var (
	procAddFontMemResourceEx    = gdi32.NewProc("AddFontMemResourceEx")
	procRemoveFontMemResourceEx = gdi32.NewProc("RemoveFontMemResourceEx")
	fontData                    [][]byte // kept alive while the fonts are registered
)

// loadEmbeddedFonts registers the embedded faces and returns a release func.
func loadEmbeddedFonts() func() {
	entries, _ := fontFiles.ReadDir("fonts")
	var handles []uintptr
	for _, e := range entries {
		data, err := fontFiles.ReadFile("fonts/" + e.Name())
		if err != nil || len(data) == 0 {
			continue
		}
		fontData = append(fontData, data)
		var count uint32
		h, _, _ := procAddFontMemResourceEx.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0, uintptr(unsafe.Pointer(&count)))
		if h != 0 {
			handles = append(handles, h)
		}
	}
	return func() {
		for _, h := range handles {
			procRemoveFontMemResourceEx.Call(h)
		}
	}
}
