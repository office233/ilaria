//go:build linux && amd64

// Package session draws a native Linux session without a webview or browser.
package session

import (
	"fmt"
	"image"
	"image/color"
	"os"
	"syscall"
	"unsafe"
)

type bitfield struct{ Offset, Length, MSBRight uint32 }
type screenInfo struct {
	XRes, YRes, XVirtual, YVirtual, XOffset, YOffset, BitsPerPixel, Gray                                                       uint32
	Red, Green, Blue, Transp                                                                                                   bitfield
	Nonstd, Activate, Height, Width, Accel, Pixclock, Left, Right, Upper, Lower, HSync, VSync, Sync, VMode, Rotate, Colorspace uint32
	Reserved                                                                                                                   [4]uint32
}
type fixedInfo struct {
	ID                             [16]byte
	SMemStart                      uint64
	SMemLen, Type, TypeAux, Visual uint32
	XPanStep, YPanStep, YWrapStep  uint16
	LineLength                     uint32
	MMIOStart                      uint64
	MMIOLen, Accel                 uint32
	Capabilities                   uint16
	Reserved                       [2]uint16
}
type Framebuffer struct {
	file   *os.File
	memory []byte
	v      screenInfo
	f      fixedInfo
	Image  *image.RGBA
}

func OpenFramebuffer(path string) (*Framebuffer, error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	fb := &Framebuffer{file: file}
	fail := func(err error) (*Framebuffer, error) { file.Close(); return nil, err }
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), 0x4600, uintptr(unsafe.Pointer(&fb.v))); e != 0 {
		return fail(e)
	}
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), 0x4602, uintptr(unsafe.Pointer(&fb.f))); e != 0 {
		return fail(e)
	}
	v, f := fb.v, fb.f
	if v.BitsPerPixel != 32 || v.Red.Length != 8 || v.Green.Length != 8 || v.Blue.Length != 8 || v.Red.Offset > 24 || v.Green.Offset > 24 || v.Blue.Offset > 24 || v.XRes < 640 || v.YRes < 480 || v.XRes > 4096 || v.YRes > 2160 || v.XOffset != 0 || v.YOffset != 0 || f.Type != 0 || f.LineLength < v.XRes*4 || f.SMemLen == 0 || f.SMemLen > 256<<20 {
		return fail(fmt.Errorf("unsupported framebuffer layout: %dx%dx%d", v.XRes, v.YRes, v.BitsPerPixel))
	}
	if uint64(f.LineLength)*uint64(v.YRes) > uint64(f.SMemLen) {
		return fail(fmt.Errorf("framebuffer bounds invalid"))
	}
	fb.memory, err = syscall.Mmap(int(file.Fd()), 0, int(f.SMemLen), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		return fail(err)
	}
	fb.Image = image.NewRGBA(image.Rect(0, 0, int(v.XRes), int(v.YRes)))
	return fb, nil
}
func (fb *Framebuffer) Close() { _ = syscall.Munmap(fb.memory); _ = fb.file.Close() }
func (fb *Framebuffer) Present() {
	im := fb.Image
	for y := 0; y < im.Rect.Dy(); y++ {
		dest := int(fb.f.LineLength) * y
		for x := 0; x < im.Rect.Dx(); x++ {
			i := y*im.Stride + x*4
			v := uint32(im.Pix[i])<<fb.v.Red.Offset | uint32(im.Pix[i+1])<<fb.v.Green.Offset | uint32(im.Pix[i+2])<<fb.v.Blue.Offset
			j := dest + x*4
			fb.memory[j] = byte(v)
			fb.memory[j+1] = byte(v >> 8)
			fb.memory[j+2] = byte(v >> 16)
			fb.memory[j+3] = byte(v >> 24)
		}
	}
}
func rect(im *image.RGBA, x, y, w, h int, c color.RGBA) {
	r := image.Rect(x, y, x+w, y+h).Intersect(im.Rect)
	for j := r.Min.Y; j < r.Max.Y; j++ {
		for i := r.Min.X; i < r.Max.X; i++ {
			im.SetRGBA(i, j, c)
		}
	}
}
