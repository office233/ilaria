//go:build linux && amd64

package session
import("testing";"unsafe")
func TestLinuxABI(t *testing.T){if unsafe.Sizeof(screenInfo{})!=160||unsafe.Sizeof(fixedInfo{})!=80{t.Fatalf("wrong framebuffer ABI %d %d",unsafe.Sizeof(screenInfo{}),unsafe.Sizeof(fixedInfo{}))};if unsafe.Offsetof(fixedInfo{}.LineLength)!=48{t.Fatal("bad stride offset")}}
func TestNativeInput(t *testing.T){if keyText(key{code:30})!="a"||keyText(key{code:53,shift:true})!="?"||keyText(key{code:59})!=""{t.Fatal("key mapping")}}
