package hir_test

import (
	"strings"
	"testing"

	"swyp-lang/internal/hir"
	"swyp-lang/internal/swyplang"
)

func TestExclusiveCallLoans(t *testing.T) {
	for _, test := range []struct {
		name, source string
		reject       bool
	}{
		{"duplicate-local", `fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run()->u64{let x:u64=7;let r=&mut x;let result:u64=f(r,r);drop(r);return result;}`, true},
		{"duplicate-parameter", `fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run(r:mutref<u64>)->u64{return f(r,r);}`, true},
		{"disjoint-locals", `fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run()->u64{let x:u64=7;let y:u64=9;let r=&mut x;let s=&mut y;let result:u64=f(r,s);drop(s);drop(r);return result;}`, false},
		{"disjoint-elements", `fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run()->u64{let xs:array<u64,2>=[7,9];let r=&mut xs[0];let s=&mut xs[1];let result:u64=f(r,s);drop(s);drop(r);return result;}`, false},
		{"disjoint-fields", `struct Pair{a:u64;b:u64;}
fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run()->u64{let p=new Pair{a:7,b:9};let r=&mut p.a;let s=&mut p.b;let result:u64=f(r,s);drop(s);drop(r);return result;}`, false},
		{"distinct-parameters", `fn f(a:mutref<u64>,b:mutref<u64>)->u64{return *a+*b;}
fn run(r:mutref<u64>,s:mutref<u64>)->u64{return f(r,s);}`, false},
		{"shared-duplicates", `fn f(a:ref<u64>,b:ref<u64>)->u64{return *a+*b;}
fn run()->u64{let x:u64=7;let r=&x;let result:u64=f(r,r);drop(r);return result;}`, false},
		{"sequential-exclusive", `fn f(a:mutref<u64>)->u64{return *a;}
fn run()->u64{let x:u64=7;let r=&mut x;let a:u64=f(r);let b:u64=f(r);drop(r);return a+b;}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := swyplang.ParseCoreModule(test.name+".swyp", "module app.main;\n"+test.source)
			if err != nil {
				t.Fatal(err)
			}
			module, err := parsed.HIRModule(nil)
			if err != nil {
				t.Fatal(err)
			}
			report, err := hir.AnalyzeOwnership(hir.Bundle{Version: hir.Version, Root: module.Name, Modules: []hir.Module{module}})
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, diagnostic := range report.Diagnostics {
				if diagnostic.Code == "exclusive_call_alias" {
					found = true
					if !strings.Contains(diagnostic.Message, "arguments 1 and 2") {
						t.Fatalf("diagnostic lacks conflicting argument positions: %+v", diagnostic)
					}
				}
			}
			if test.reject && !found {
				t.Fatalf("duplicate exclusive call loan accepted: %+v", report)
			}
			if !test.reject && len(report.Diagnostics) != 0 {
				t.Fatalf("valid independent/shared/sequential loans rejected: %+v", report)
			}
		})
	}
}
