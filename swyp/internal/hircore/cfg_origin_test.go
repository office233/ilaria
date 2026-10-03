package hircore

import (
	"context"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hir"
	"swyp-lang/internal/swyplang"
)

func TestLowerPreservesCurrentBlockAfterNestedCFGExpression(t *testing.T) {
	source := `module app.main;
fn run() -> bool {
    let v: vec<ieee64> = [1.5, 2.5, 3.5];
    vec_push(v, -3.5);
    let x: ieee64 = v[0];
    let y: ieee64 = v[3];
    drop(v);
    return x == 1.5 && y == -3.5;
}`
	p, err := swyplang.ParseCoreModule("cfg.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 10000)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Value.Boolean()
	if !ok || !v {
		t.Fatalf("result=%v bool=%v ok=%v", got.Value, v, ok)
	}
}

func TestLowerIfAndWhileUseActualCurrentPredecessor(t *testing.T) {
	source := `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [1];
    vec_push(v, 2);
    let n: u64 = vec_len(v);
    if n == 2 { vec_push(v, 3); }
    let i: u64 = 0;
    while i > 0 { vec_push(v, 4); }
    let out: u64 = vec_len(v);
    drop(v);
    return out;
}`
	p, err := swyplang.ParseCoreModule("cfg.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 20000)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Value.Uint64()
	if !ok || v != 3 {
		t.Fatalf("result=%v u64=%d ok=%v", got.Value, v, ok)
	}
}

func TestLowerStorageVecOfFlatStructAcrossReturnAndParameter(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: u64; }
fn make() -> vec<Pair> {
    let v: vec<Pair> = [new Pair { a: 10, b: 20 }, new Pair { a: 30, b: 40 }];
    return v;
}
fn consume(v: vec<Pair>) -> u64 {
    let first: u64 = v[0].b;
    vec_push(v, new Pair { a: 50, b: 60 });
    let last: u64 = v[2].b;
    let n: u64 = vec_len(v);
    drop(v);
    return first + last + n;
}
fn run() -> u64 {
    let v: vec<Pair> = make();
    return consume(v);
}`
	p, err := swyplang.ParseCoreModule("vec-struct.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 30000)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Value.Uint64()
	if !ok || v != 83 {
		t.Fatalf("result=%v u64=%d ok=%v want=83", got.Value, v, ok)
	}
}

func TestLowerStorageVecStructFieldMutableRef(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: i64; }
fn run() -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[1].b;
    store(r, -9);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[1].b;
    drop(v);
    return x == -9 && y == -9;
}`
	p, err := swyplang.ParseCoreModule("vec-struct-ref.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 30000)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Value.Boolean()
	if !ok || !v {
		t.Fatalf("result=%v bool=%v ok=%v", got.Value, v, ok)
	}
}

func TestLowerStorageVecStructWholeElementCopy(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let p: Pair = v[i];
    let a: u64 = p.a;
    let b: i64 = p.b;
    drop(v);
    return (i == 0 && a == 10 && b == -2) || (i == 1 && a == 20 && b == 4);
}`
	p, err := swyplang.ParseCoreModule("vec-struct-copy.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range []uint64{0, 1} {
		got, err := exec.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(index)}, 30000)
		if err != nil {
			t.Fatal(err)
		}
		v, ok := got.Value.Boolean()
		if !ok || !v {
			t.Fatalf("index=%d result=%v bool=%v ok=%v", index, got.Value, v, ok)
		}
	}
}

func TestLowerStorageSliceOfStructFieldAndCopy(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let direct: i64 = s[i].b;
    let p: Pair = s[i];
    let copied: i64 = p.b;
    drop(s);
    drop(v);
    return (i == 0 && direct == 4 && copied == 4) || (i == 1 && direct == 8 && copied == 8);
}`
	p, err := swyplang.ParseCoreModule("slice-struct.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range []uint64{0, 1} {
		got, err := exec.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(index)}, 40000)
		if err != nil {
			t.Fatal(err)
		}
		v, ok := got.Value.Boolean()
		if !ok || !v {
			t.Fatalf("index=%d result=%v bool=%v ok=%v", index, got.Value, v, ok)
		}
	}
	if _, err := exec.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(2)}, 40000); err == nil {
		t.Fatal("struct slice out-of-bounds index unexpectedly succeeded")
	}
}

func TestLowerStorageSliceStructFieldSharedRef(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let r = &s[i].b;
    let x: i64 = *r;
    drop(r);
    drop(s);
    drop(v);
    return x;
}`
	p, err := swyplang.ParseCoreModule("slice-struct-ref.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index uint64
		want  int64
	}{{0, 4}, {1, 8}} {
		got, err := exec.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(tc.index)}, 40000)
		if err != nil {
			t.Fatal(err)
		}
		v, ok := got.Value.Int64()
		if !ok || v != tc.want {
			t.Fatalf("index=%d result=%v i64=%d ok=%v want=%d", tc.index, got.Value, v, ok, tc.want)
		}
	}
}

func TestLowerRejectsMutableRefThroughStorageSlice(t *testing.T) {
	source := `module app.main;
struct Pair { a: u64; b: i64; }
fn run() {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }];
    let s: slice<Pair> = v[0:1];
    let r = &mut s[0].b;
    store(r, -9);
    drop(r);
    drop(s);
    drop(v);
}`
	p, err := swyplang.ParseCoreModule("slice-struct-mutref.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run"); err == nil {
		t.Fatal("mutable reference through slice unexpectedly lowered")
	}
}

func TestLowerNestedStructVecStorageLeafProjectionAndRef(t *testing.T) {
	source := `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run() -> bool {
    let v: vec<Outer> = [
        new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 },
        new Outer { inner: new Inner { value: 4, code: 2 }, ratio: 2.5 }
    ];
    vec_push(v, new Outer { inner: new Inner { value: 12, code: 3 }, ratio: 3.5 });
    let before: i64 = v[1].inner.value;
    let r = &mut v[1].inner.value;
    store(r, -9);
    let after: i64 = *r;
    drop(r);
    let pushed: i64 = v[2].inner.value;
    let ratio: ieee64 = v[2].ratio;
    drop(v);
    return before == 4 && after == -9 && pushed == 12 && ratio == 3.5;
}`
	p, err := swyplang.ParseCoreModule("nested-vec.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 50000)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Value.Boolean()
	if !ok || !v {
		t.Fatalf("result=%v bool=%v ok=%v", got.Value, v, ok)
	}
}

func TestLowerNestedStructVecWholeElementCopyAndLocalRef(t *testing.T) {
	source := `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run() -> bool {
    let local: Outer = new Outer { inner: new Inner { value: -1, code: 7 }, ratio: 1.25 };
    let local_value: i64 = local.inner.value;
    let v: vec<Outer> = [new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 2.5 }];
    let x: Outer = v[0];
    let before: i64 = x.inner.value;
    let r = &mut x.inner.value;
    store(r, -9);
    let after: i64 = *r;
    drop(r);
    drop(v);
    return local_value == -1 && before == -2 && after == -9 && x.inner.value == -9;
}`
	p, err := swyplang.ParseCoreModule("nested-copy.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := exec.Run(context.Background(), result.Entry, nil, 50000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := got.Value.Boolean()
	if !ok || !value {
		t.Fatalf("result=%v bool=%v ok=%v", got.Value, value, ok)
	}
}

func TestLowerNestedStructSliceLeafProjectionAndSharedRef(t *testing.T) {
	source := `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run(i: u64) -> bool {
    let v: vec<Outer> = [
        new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 },
        new Outer { inner: new Inner { value: 4, code: 2 }, ratio: 2.5 },
        new Outer { inner: new Inner { value: 8, code: 3 }, ratio: 3.5 }
    ];
    let s: slice<Outer> = v[1:3];
    let direct: i64 = s[i].inner.value;
    let copied: Outer = s[i];
    let copied_value: i64 = copied.inner.value;
    let r = &s[i].inner.value;
    let via_ref: i64 = *r;
    drop(r);
    drop(s);
    drop(v);
    return (i == 0 && direct == 4 && copied_value == 4 && via_ref == 4) || (i == 1 && direct == 8 && copied_value == 8 && via_ref == 8);
}`
	p, err := swyplang.ParseCoreModule("nested-slice.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.HIRModule(nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: m.Name, Modules: []hir.Module{m}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	exec, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, index := range []uint64{0, 1} {
		got, err := exec.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(index)}, 50000)
		if err != nil {
			t.Fatal(err)
		}
		value, ok := got.Value.Boolean()
		if !ok || !value {
			t.Fatalf("index=%d result=%v bool=%v ok=%v", index, got.Value, value, ok)
		}
	}
}
