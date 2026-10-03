package swyplang

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func coreCompileTest(t *testing.T, source, entry string) *coreir.Executable {
	t.Helper()
	p, err := ParseCore("core-test.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		t.Fatal(err)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func TestCoreSourceNumericAndControlFlow(t *testing.T) {
	cases := []struct {
		name, source, input, want string
		typ                       coreir.Type
	}{
		{"exact input", `fn f(x:i64)->i64{return x+1;} fn main(){}`, "9007199254740993", "9007199254740994", coreir.I64},
		{"exact literal", `fn f(x:i64)->i64{return 9007199254740993;} fn main(){}`, "0", "9007199254740993", coreir.I64},
		{"minimum", `fn f(x:i64)->i64{return -9223372036854775808;} fn main(){}`, "0", "-9223372036854775808", coreir.I64},
		{"integer division", `fn f(x:i64)->i64{return x/3;} fn main(){}`, "-7", "-2", coreir.I64},
		{"integer remainder", `fn f(x:i64)->i64{return x%3;} fn main(){}`, "-7", "-1", coreir.I64},
		{"loop", `fn f(x:i64)->i64{let i:i64=0;let y:i64=0;while i<x {y=y+i;i=i+1;}return y;} fn main(){}`, "10", "45", coreir.I64},
		{"shadow", `fn f(x:i64)->i64{let y:i64=x;if x>0 {let y:i64=y+1;y=y*2;}return y;} fn main(){}`, "9", "9", coreir.I64},
		{"calls", `fn square(x:i64)->i64{return x*x;} fn f(x:i64)->i64{return square(x)+square(x+1);} fn main(){}`, "3", "25", coreir.I64},
		{"short and", `fn f(x:i64)->bool{return x!=0 && 10/x>0;} fn main(){}`, "0", "false", coreir.I64},
		{"short or", `fn f(x:i64)->bool{return x==0 || 10/x>0;} fn main(){}`, "0", "true", coreir.I64},
		{"nested bool", `fn f(x:i64)->bool{return (x==0 || 10/x>0) && !(x<0);} fn main(){}`, "0", "true", coreir.I64},
		{"early returns", `fn f(x:i64)->i64{if x<0 {return -x;}else{return x;}} fn main(){}`, "-9", "9", coreir.I64},
		{"f64 division", `fn f(x:f64)->f64{return x/2;} fn main(){}`, "5", "2.5", coreir.F64},
		{"ieee64 division", `fn f(x:ieee64)->ieee64{return x/2;} fn main(){}`, "5", "2.5", coreir.IEEE64},
		{"u64 wrap", `fn f(x:u64)->u64{return x+1;} fn main(){}`, "18446744073709551615", "0", coreir.U64},
		{"u64 bitwise precedence", `fn f(x:u64)->u64{return x&255|1<<8;} fn main(){}`, "511", "511", coreir.U64},
		{"legacy number", `fn f(x:number)->number{return x/2;} fn main(){print(f(arg(0)));}`, "5", "2.5", coreir.F64},
		{"negative zero", `fn f(x:f64)->f64{return -0;} fn main(){}`, "1", "-0", coreir.F64},
		{"cross type equality", `fn f(x:number)->bool{return x==true;} fn main(){}`, "1", "false", coreir.F64},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := coreCompileTest(t, c.source, "f")
			x, err := coreir.ParseValue(c.typ, c.input)
			if err != nil {
				t.Fatal(err)
			}
			r, err := e.Run(context.Background(), "f", []coreir.Value{x}, 10000)
			if err != nil || r.Value.Literal().Value != c.want {
				t.Fatalf("got %v %v, want %s", r, err, c.want)
			}
		})
	}
}
func TestCoreSourceRejectsInvalidAndImpure(t *testing.T) {
	for _, source := range []string{
		`fn f(x:i64)->i64{return x+1.5;} fn main(){}`,
		`fn f(x:i64)->i64{let y=1;return x+y;} fn main(){}`,
		`fn f(x:i64)->i64{return 9223372036854775808;} fn main(){}`,
		`fn f(x:i64)->i64{if x>0{return x;}} fn main(){}`,
		`fn f(x:i64)->i64{return x;let y=missing;} fn main(){}`,
		`fn g()->number{return clock();} fn f(x:i64)->i64{g();return x;} fn main(){}`,
		`fn f(x)->number{return x;} fn main(){}`,
		`fn f(x:i64)->i64{if x>0{let y:i64=1;}return y;} fn main(){}`,
	} {
		p, err := ParseCore("invalid.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = p.CoreIR("f"); err == nil {
			t.Fatalf("accepted %s", source)
		}
	}
}

func TestCoreSourceLowersPrintAsExplicitEffect(t *testing.T) {
	p, err := ParseCore("effect.swyp", `
fn helper(x:i64)->i64{print(x);return x;}
fn f(x:i64)->i64{return helper(x);}
fn main(){}
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("f")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Functions) != 2 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	for _, f := range m.Functions {
		if f.EffectVersion != coreir.EffectVersion || len(f.Effects) != 1 || f.Effects[0] != coreir.EffectIOStdout {
			t.Fatalf("%s effects=%v version=%d", f.Name, f.Effects, f.EffectVersion)
		}
		if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "stdout_write" || f.RequiredCapabilities[0].Effect != coreir.EffectIOStdout {
			t.Fatalf("%s caps=%v", f.Name, f.RequiredCapabilities)
		}
	}
	helper := m.Functions[0]
	if helper.Name != "f" {
		helper = m.Functions[1]
	}
	if helper.Name == "f" {
		// Sorted source lowering places f before helper. Pick helper explicitly.
		for _, candidate := range m.Functions {
			if candidate.Name == "helper" {
				helper = candidate
			}
		}
	}
	found := false
	for _, block := range helper.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "io.stdout" {
				found = true
				if ins.Dest != -1 || len(ins.Args) != 1 || !ins.MayTrap {
					t.Fatalf("stdout instruction=%+v", ins)
				}
			}
		}
	}
	if !found {
		t.Fatal("io.stdout instruction missing")
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Run(context.Background(), "f", []coreir.Value{coreir.Int(7)}, 100); err == nil || !strings.Contains(err.Error(), "effectful_program") {
		t.Fatalf("effectful Core execution was not broker-gated: %v", err)
	}
}

func TestCoreSourcePrintRequiresOneScalar(t *testing.T) {
	p, err := ParseCore("print.swyp", `fn f(x:i64)->i64{print(x,x);return x;} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CoreIR("f"); err == nil || !strings.Contains(err.Error(), "exactly one scalar") {
		t.Fatalf("multi-arg Core print was not rejected: %v", err)
	}
}

func TestCoreSourceLowersEprintAsStderrEffect(t *testing.T) {
	p, err := ParseCore("stderr.swyp", `fn f(x:i64)->i64{eprint(x);return x;} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("f")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Functions) != 1 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectIOStderr {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "stderr_write" || f.RequiredCapabilities[0].Effect != coreir.EffectIOStderr {
		t.Fatalf("caps=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "io.stderr" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("io.stderr instruction missing")
	}
}

func TestCoreSourceLowersClockAsCapabilityGatedEffect(t *testing.T) {
	p, err := ParseCore("clock.swyp", `fn now()->u64{return clock();} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("now")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Functions) != 1 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	f := m.Functions[0]
	if f.Result != coreir.U64 || len(f.Effects) != 1 || f.Effects[0] != coreir.EffectClockRead {
		t.Fatalf("result=%s effects=%v", f.Result, f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "clock_read" || f.RequiredCapabilities[0].Effect != coreir.EffectClockRead {
		t.Fatalf("capabilities=%+v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "clock.read" {
				found = true
				if ins.Dest < 0 || len(ins.Args) != 0 || !ins.MayTrap || f.Slots[ins.Dest] != coreir.U64 {
					t.Fatalf("clock instruction=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("clock.read instruction missing")
	}
}

func TestCoreSourceLowersRandomAsCapabilityGatedEffect(t *testing.T) {
	p, err := ParseCore("rng.swyp", `fn sample()->u64{return random();} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("sample")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Functions) != 1 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	f := m.Functions[0]
	if f.Result != coreir.U64 || len(f.Effects) != 1 || f.Effects[0] != coreir.EffectRNGSample {
		t.Fatalf("result=%s effects=%v", f.Result, f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "rng_sample" || f.RequiredCapabilities[0].Effect != coreir.EffectRNGSample {
		t.Fatalf("capabilities=%+v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "rng.sample" {
				found = true
				if ins.Dest < 0 || len(ins.Args) != 0 || !ins.MayTrap || f.Slots[ins.Dest] != coreir.U64 {
					t.Fatalf("rng instruction=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("rng.sample instruction missing")
	}
}

func TestCoreSourceLowersOpaqueBytesTransport(t *testing.T) {
	p, err := ParseCore("bytes.swyp", `fn id(x:bytes)->bytes{return x;} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("id")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Functions) != 1 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	f := m.Functions[0]
	if len(f.Params) != 1 || f.Params[0].Type != coreir.Bytes || f.Result != coreir.Bytes {
		t.Fatalf("params=%v result=%s", f.Params, f.Result)
	}
}

func TestCoreSourceLowersWriteFileEffect(t *testing.T) {
	p, err := ParseCore("fs-write.swyp", `
fn save()->i64 {
  write_file("swyp-test.txt", "hello");
  return 7;
}
fn main(){}
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("save")
	if err != nil {
		t.Fatal(err)
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectFSWrite {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "workspace_write" || f.RequiredCapabilities[0].Effect != coreir.EffectFSWrite {
		t.Fatalf("capabilities=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "fs.write" {
				found = true
				if len(ins.Args) != 2 || f.Slots[ins.Args[0]] != coreir.Bytes || f.Slots[ins.Args[1]] != coreir.Bytes || ins.Dest != -1 || !ins.MayTrap {
					t.Fatalf("fs.write=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("fs.write instruction missing")
	}
}

func TestCoreSourceLowersReadFileEffect(t *testing.T) {
	p, err := ParseCore("fs-read.swyp", `
fn load()->bytes {
  return read_file("swyp-test.txt");
}
fn main(){}
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("load")
	if err != nil {
		t.Fatal(err)
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectFSRead {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "workspace_read" || f.RequiredCapabilities[0].Effect != coreir.EffectFSRead {
		t.Fatalf("capabilities=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "fs.read" {
				found = true
				if len(ins.Args) != 1 || f.Slots[ins.Args[0]] != coreir.Bytes || ins.Dest < 0 || f.Slots[ins.Dest] != coreir.Bytes || !ins.MayTrap {
					t.Fatalf("fs.read=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("fs.read instruction missing")
	}
}

func TestCoreSourceLowersTCPConnectEffect(t *testing.T) {
	p, err := ParseCore("net-connect.swyp", `fn ping(port:u64)->bool{return tcp_connect("127.0.0.1",port);} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("ping")
	if err != nil {
		t.Fatal(err)
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectNetConnect {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "network_connect" || f.RequiredCapabilities[0].Effect != coreir.EffectNetConnect {
		t.Fatalf("capabilities=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "net.connect" {
				found = true
				if len(ins.Args) != 2 || f.Slots[ins.Args[0]] != coreir.Bytes || f.Slots[ins.Args[1]] != coreir.U64 || ins.Dest < 0 || f.Slots[ins.Dest] != coreir.Bool || !ins.MayTrap {
					t.Fatalf("net.connect=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("net.connect instruction missing")
	}
}

func TestCoreSourceLowersHTTPFetchEffect(t *testing.T) {
	p, err := ParseCore("net-fetch.swyp", `fn load(port:u64)->bytes{return http_fetch("127.0.0.1",port,"/health");} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("load")
	if err != nil {
		t.Fatal(err)
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectNetFetch {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "network_fetch" || f.RequiredCapabilities[0].Effect != coreir.EffectNetFetch {
		t.Fatalf("capabilities=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "net.fetch" {
				found = true
				if len(ins.Args) != 3 || f.Slots[ins.Args[0]] != coreir.Bytes || f.Slots[ins.Args[1]] != coreir.U64 || f.Slots[ins.Args[2]] != coreir.Bytes || ins.Dest < 0 || f.Slots[ins.Dest] != coreir.Bytes || !ins.MayTrap {
					t.Fatalf("net.fetch=%+v slots=%v", ins, f.Slots)
				}
			}
		}
	}
	if !found {
		t.Fatal("net.fetch instruction missing")
	}
}

func TestCoreSourceLowersProcessExecEffect(t *testing.T) {
	p, err := ParseCore("process-exec.swyp", `fn run()->u64{return process_exec("tool.exe",2,"one","two","","");} fn main(){}`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("run")
	if err != nil {
		t.Fatal(err)
	}
	f := m.Functions[0]
	if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectProcessExec {
		t.Fatalf("effects=%v", f.Effects)
	}
	if len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "process_exec" || f.RequiredCapabilities[0].Effect != coreir.EffectProcessExec {
		t.Fatalf("capabilities=%v", f.RequiredCapabilities)
	}
	found := false
	for _, block := range f.Blocks {
		for _, ins := range block.Instructions {
			if ins.Op != "process.exec" {
				continue
			}
			found = true
			if len(ins.Args) != 6 || f.Slots[ins.Args[0]] != coreir.Bytes || f.Slots[ins.Args[1]] != coreir.U64 || ins.Dest < 0 || f.Slots[ins.Dest] != coreir.U64 || !ins.MayTrap {
				t.Fatalf("process.exec=%+v slots=%v", ins, f.Slots)
			}
			for _, arg := range ins.Args[2:] {
				if f.Slots[arg] != coreir.Bytes {
					t.Fatalf("process.exec argv slot type=%s", f.Slots[arg])
				}
			}
		}
	}
	if !found {
		t.Fatal("process.exec instruction missing")
	}
}

func TestCoreSourceInternsStringLiteralsIntoReadOnlyByteArena(t *testing.T) {
	p, err := ParseCore("bytes-literal.swyp", `
fn choose(c:bool)->bytes {
  if c { return "hello"; }
  return "hello";
}
fn main(){}
`)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CoreIR("choose")
	if err != nil {
		t.Fatal(err)
	}
	if string(m.Data) != "hello" {
		t.Fatalf("arena=%q", m.Data)
	}
	if len(m.Functions) != 1 {
		t.Fatalf("functions=%d", len(m.Functions))
	}
	var descriptors []string
	for _, block := range m.Functions[0].Blocks {
		for _, ins := range block.Instructions {
			if ins.Op == "const" && ins.Constant != nil && ins.Constant.Type == coreir.Bytes {
				descriptors = append(descriptors, ins.Constant.Value)
			}
		}
	}
	if len(descriptors) != 2 || descriptors[0] != descriptors[1] {
		t.Fatalf("descriptors=%v", descriptors)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, cond := range []bool{true, false} {
		result, err := e.Run(context.Background(), "choose", []coreir.Value{coreir.Boolean(cond)}, 100)
		if err != nil {
			t.Fatal(err)
		}
		got, err := e.ResolveBytes(result.Value)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != "hello" {
			t.Fatalf("cond=%v resolved=%q", cond, got)
		}
	}
}

func TestCoreBytesLenAndGetAcrossExecutionModes(t *testing.T) {
	p, err := ParseCore("bytes-access.swyp", `
fn length()->u64{return bytes_len("hello");}
fn second()->u64{return bytes_get("abc",1);}
fn oob()->u64{return bytes_get("abc",3);}
fn main(){}
`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		entry string
		want  uint64
	}{
		{"length", 5},
		{"second", uint64('b')},
	} {
		m, err := p.CoreIR(tc.entry)
		if err != nil {
			t.Fatalf("%s lowering: %v", tc.entry, err)
		}
		e, err := coreir.Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		for mode, run := range map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error){
			"run":   e.Run,
			"fast":  e.RunFast,
			"turbo": e.RunTurbo,
		} {
			result, err := run(context.Background(), tc.entry, nil, 100)
			if err != nil {
				t.Fatalf("%s/%s: %v", tc.entry, mode, err)
			}
			got, ok := result.Value.Uint64()
			if !ok || got != tc.want {
				t.Fatalf("%s/%s got=%v want=%d", tc.entry, mode, result.Value, tc.want)
			}
		}
	}

	m, err := p.CoreIR("oob")
	if err != nil {
		t.Fatal(err)
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		t.Fatal(err)
	}
	for mode, run := range map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error){
		"run":   e.Run,
		"fast":  e.RunFast,
		"turbo": e.RunTurbo,
	} {
		_, err := run(context.Background(), "oob", nil, 100)
		if err == nil || !strings.Contains(err.Error(), "bounds") {
			t.Fatalf("%s oob err=%v", mode, err)
		}
	}
}
func TestCoreSourceRetainsRuntimeErrorsAndIsolation(t *testing.T) {
	for _, body := range []string{`return (x+1)-1;`, `return -x;`, `return x/-1;`} {
		e := coreCompileTest(t, `fn f(x:i64)->i64{`+body+`} fn main(){}`, "f")
		input := int64(-1 << 63)
		if strings.Contains(body, "x+1") {
			input = 1<<63 - 1
		}
		if _, err := e.Run(context.Background(), "f", []coreir.Value{coreir.Int(input)}, 100); err == nil {
			t.Fatal("lost intermediate trap", body)
		}
	}
	e := coreCompileTest(t, `fn f(x:i64)->i64{return f(x);} fn main(){}`, "f")
	if _, err := e.Run(context.Background(), "f", []coreir.Value{coreir.Int(1)}, 10000); err == nil || !strings.Contains(err.Error(), "call_depth") {
		t.Fatal(err)
	}
	p, err := ParseCore("isolation.swyp", `fn main()->i64{return 1;}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Check(); err == nil {
		t.Fatal("legacy checker accepted core mode")
	}
	if err := p.Run(io.Discard, 100); err == nil {
		t.Fatal("legacy interpreter accepted core mode")
	}
	if _, err := p.EmitC(); err == nil {
		t.Fatal("legacy C emitter accepted core mode")
	}
	if _, err := p.CompileSTV2(); err == nil {
		t.Fatal("STV2 accepted core mode")
	}
	if _, err := p.EmitHTML(); err == nil {
		t.Fatal("legacy JS emitter accepted core mode")
	}
	if _, err := Parse("legacy.swyp", `fn main()->i64{return 1;}`); err == nil {
		t.Fatal("legacy syntax silently extended")
	}
}
func TestCoreDifferential10000(t *testing.T) {
	seen := map[string]bool{}
	inputs := []int64{-3, 0, 7}
	for k := 0; k < 10000; k++ {
		body := fmt.Sprintf(`let y=x+%d;if x<0{y=y*2;}else{y=y-3;}let i=0;while i<%d{y=y+x;i=i+1;}return y;`, k, k%5)
		source := `fn kernel(x:number)->number{` + body + `} fn main(){print(kernel(arg(0)));}`
		if seen[source] {
			t.Fatal("duplicate generated source")
		}
		seen[source] = true
		p, err := Parse("corpus.swyp", source)
		if err != nil {
			t.Fatal(err)
		}
		if err := p.Check(); err != nil {
			t.Fatal(err)
		}
		m, err := p.CoreIR("kernel")
		if err != nil {
			t.Fatalf("%d: %v", k, err)
		}
		e, err := coreir.Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		if k < 50 {
			m2, err := p.CoreIR("kernel")
			if err != nil {
				t.Fatal(err)
			}
			a, _ := json.Marshal(m)
			b, _ := json.Marshal(m2)
			if !bytes.Equal(a, b) {
				t.Fatal("nondeterministic lowering")
			}
		}
		sp, err := Parse("stv2-corpus.swyp", `fn main()->number{let x=arg(0);`+body+`}`)
		if err != nil {
			t.Fatal(err)
		}
		sm, err := sp.CompileSTV2()
		if err != nil {
			t.Fatalf("STV2 %d: %v", k, err)
		}
		for _, x := range inputs {
			want := x + int64(k)
			if x < 0 {
				want *= 2
			} else {
				want -= 3
			}
			want += x * int64(k%5)
			cv, _ := coreir.ParseValue(coreir.F64, strconv.FormatInt(x, 10))
			r, err := e.Run(context.Background(), "kernel", []coreir.Value{cv}, 1000)
			fv, ok := r.Value.Float64()
			if err != nil || !ok || fv != float64(want) {
				t.Fatalf("core k=%d x=%d: %v %v want %d", k, x, r, err, want)
			}
			var output bytes.Buffer
			if err := p.RunArgs(&output, 1000, []float64{float64(x)}); err != nil {
				t.Fatal(err)
			}
			av, err := strconv.ParseFloat(strings.TrimSpace(output.String()), 64)
			if err != nil || av != float64(want) {
				t.Fatalf("AST %d: %s", k, output.String())
			}
			sv, err := sm.Run([]int64{x}, 1000)
			if err != nil || sv.Value != want {
				t.Fatalf("STV2 %d: %v %v", k, sv, err)
			}
		}
	}
	t.Logf("%d distinct programs; %d input cases; core/AST/STV2 compared with independent integer oracle", len(seen), len(seen)*len(inputs))
}
func FuzzCoreLower(f *testing.F) {
	f.Add(`fn main()->i64{return 9007199254740993;}`)
	f.Add(`fn main()->bool{return false && 1/0>0;}`)
	f.Fuzz(func(t *testing.T, source string) {
		p, err := ParseCore("fuzz.swyp", source)
		if err != nil {
			return
		}
		m, err := p.CoreIR("main")
		if err != nil {
			return
		}
		e, err := coreir.Prepare(m)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = e.Run(context.Background(), "main", nil, 128)
	})
}
