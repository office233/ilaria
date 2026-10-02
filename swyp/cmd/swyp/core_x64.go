package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

type x64LeafArtifact struct {
	Assembly []byte
	Function coreir.Function
	SSA      coreir.SSAFunction
	Plan     coreir.SSARegisterPlan
	Symbol   string
}

type x64LeafIRArtifact struct {
	Function coreir.Function
	SSA      coreir.SSAFunction
	Plan     coreir.SSARegisterPlan
	Symbol   string
}

type x64ModuleIRArtifact struct {
	Module      coreir.Module
	Functions   []coreir.SSAFunction
	Plans       map[string]coreir.SSARegisterPlan
	Entry       coreir.Function
	EntrySSA    coreir.SSAFunction
	EntryPlan   coreir.SSARegisterPlan
	EntrySymbol string
}

func compileX64ModuleIR(sourcePath, entry string) (x64ModuleIRArtifact, error) {
	return compileX64ModuleIRMode(sourcePath, entry, false)
}

func compileX64PackModuleIR(sourcePath, entry string) (x64ModuleIRArtifact, error) {
	return compileX64ModuleIRMode(sourcePath, entry, true)
}

func compileX64ModuleIRMode(sourcePath, entry string, allowFPCalls bool) (x64ModuleIRArtifact, error) {
	return compileX64ModuleIRCapabilities(sourcePath, entry, allowFPCalls, false)
}

func compileX64ExeModuleIR(sourcePath, entry string) (x64ModuleIRArtifact, error) {
	return compileX64ModuleIRCapabilities(sourcePath, entry, true, true)
}

func compileX64ModuleIRCapabilities(sourcePath, entry string, allowFPCalls, allowProcessIO bool) (x64ModuleIRArtifact, error) {
	input, err := readModuleInput(sourcePath, coreir.MaxBytes)
	if err != nil {
		return x64ModuleIRArtifact{}, err
	}
	p, err := swyplang.ParseCore(sourcePath, string(input))
	if err != nil {
		return x64ModuleIRArtifact{}, err
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		return x64ModuleIRArtifact{}, err
	}
	return prepareX64ModuleIR(m, entry, allowFPCalls, allowProcessIO)
}

// prepareX64ModuleIR is the shared backend boundary for source-lowered and
// linked-HIR Core modules. Everything after this point is architecture/backend
// validation, optimization, SSA and register allocation.
func prepareX64ModuleIR(m coreir.Module, entry string, allowFPCalls, allowProcessIO bool) (x64ModuleIRArtifact, error) {
	var err error
	m, _, err = coreir.Optimize(m)
	if err != nil {
		return x64ModuleIRArtifact{}, err
	}
	m, err = pruneX64NativeModule(m, entry)
	if err != nil {
		return x64ModuleIRArtifact{}, err
	}
	if err := validateX64NativeModuleMode(m, entry, allowFPCalls, allowProcessIO); err != nil {
		return x64ModuleIRArtifact{}, err
	}
	artifact := x64ModuleIRArtifact{
		Module:    m,
		Plans:     make(map[string]coreir.SSARegisterPlan, len(m.Functions)),
		Functions: make([]coreir.SSAFunction, 0, len(m.Functions)),
	}
	for i := range m.Functions {
		function := m.Functions[i]
		ssa, err := coreir.BuildSSA(function)
		if err != nil {
			return x64ModuleIRArtifact{}, fmt.Errorf("x64 %s SSA: %w", function.Name, err)
		}
		plan, err := coreir.AllocateSSARegisters(ssa, coreir.X64LeafRegisterCount(), coreir.X64FPRegisterCount())
		if err != nil {
			return x64ModuleIRArtifact{}, fmt.Errorf("x64 %s register allocation: %w", function.Name, err)
		}
		artifact.Functions = append(artifact.Functions, ssa)
		artifact.Plans[function.Name] = plan
		if function.Name == entry {
			artifact.Entry = function
			artifact.EntrySSA = ssa
			artifact.EntryPlan = plan
			artifact.EntrySymbol = coreir.X64LeafSymbol(entry)
		}
	}
	if artifact.Entry.Name == "" {
		return x64ModuleIRArtifact{}, fmt.Errorf("entry %q not found", entry)
	}
	return artifact, nil
}

func pruneX64NativeModule(m coreir.Module, entry string) (coreir.Module, error) {
	byName := make(map[string]coreir.Function, len(m.Functions))
	for _, f := range m.Functions {
		byName[f.Name] = f
	}
	if _, ok := byName[entry]; !ok {
		return coreir.Module{}, fmt.Errorf("entry %q not found", entry)
	}
	reachable := make(map[string]bool, len(m.Functions))
	var visit func(string) error
	visit = func(name string) error {
		if reachable[name] {
			return nil
		}
		f, ok := byName[name]
		if !ok {
			return fmt.Errorf("x64 native module references unknown function %q", name)
		}
		reachable[name] = true
		for _, block := range f.Blocks {
			for _, ins := range block.Instructions {
				if ins.Op == "call" {
					if err := visit(ins.Callee); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	if err := visit(entry); err != nil {
		return coreir.Module{}, err
	}
	functions := make([]coreir.Function, 0, len(reachable))
	for _, f := range m.Functions {
		if reachable[f.Name] {
			functions = append(functions, f)
		}
	}
	m.Functions = functions
	if err := m.Validate(); err != nil {
		return coreir.Module{}, fmt.Errorf("x64 native pruning produced invalid module: %w", err)
	}
	return m, nil
}

func validateX64NativeModule(m coreir.Module, entry string) error {
	return validateX64NativeModuleMode(m, entry, false, false)
}

func validateX64NativeModuleMode(m coreir.Module, entry string, allowFPCalls, allowProcessIO bool) error {
	functions := make(map[string]coreir.Function, len(m.Functions))
	for _, f := range m.Functions {
		if f.Result == coreir.Bytes {
			return fmt.Errorf("x64 native backend function %s: bytes result requires byte arena support", f.Name)
		}
		for i, param := range f.Params {
			if param.Type == coreir.Bytes {
				return fmt.Errorf("x64 native backend function %s: bytes parameter %d requires byte arena support", f.Name, i)
			}
		}
		for bi, block := range f.Blocks {
			for ii, ins := range block.Instructions {
				if ins.Op == "bytes.get" && !allowProcessIO {
					return fmt.Errorf("x64 native backend function %s block %d instruction %d: bytes.get requires native byte-arena mapping", f.Name, bi, ii)
				}
			}
		}
		if err := validateNativeProcessEffects(f, allowProcessIO); err != nil {
			return fmt.Errorf("x64 native backend function %s: %w", f.Name, err)
		}
		functions[f.Name] = f
	}
	if _, ok := functions[entry]; !ok {
		return fmt.Errorf("entry %q not found", entry)
	}
	state := make(map[string]uint8, len(functions))
	var visit func(string) error
	visit = func(name string) error {
		switch state[name] {
		case 1:
			return fmt.Errorf("x64 native backend does not support recursive call cycle at %s", name)
		case 2:
			return nil
		}
		state[name] = 1
		f := functions[name]
		for _, block := range f.Blocks {
			for _, ins := range block.Instructions {
				if ins.Op != "call" {
					continue
				}
				callee, ok := functions[ins.Callee]
				if !ok {
					return fmt.Errorf("x64 native call from %s to unknown %s", name, ins.Callee)
				}
				if len(ins.Args) > 4 || len(callee.Params) > 4 {
					return fmt.Errorf("x64 native call %s -> %s exceeds 4 GPR arguments", name, ins.Callee)
				}
				if !x64NativeCallType(callee.Result, allowFPCalls) {
					return fmt.Errorf("x64 native call %s -> %s result type %s is unsupported", name, ins.Callee, callee.Result)
				}
				for i, param := range callee.Params {
					if !x64NativeCallType(param.Type, allowFPCalls) {
						return fmt.Errorf("x64 native call %s -> %s argument %d type %s is unsupported", name, ins.Callee, i, param.Type)
					}
				}
				if err := visit(ins.Callee); err != nil {
					return err
				}
			}
		}
		state[name] = 2
		return nil
	}
	return visit(entry)
}

func validateNativeProcessEffects(f coreir.Function, allowProcessIO bool) error {
	if f.EffectVersion == 0 && len(f.Effects) == 0 && len(f.RequiredCapabilities) == 0 {
		return nil
	}
	if !allowProcessIO {
		return fmt.Errorf("requires pure function")
	}
	wantCaps := map[string]string{
		coreir.EffectClockRead:   "clock_read",
		coreir.EffectFSRead:      "workspace_read",
		coreir.EffectFSWrite:     "workspace_write",
		coreir.EffectIOStdout:    "stdout_write",
		coreir.EffectIOStderr:    "stderr_write",
		coreir.EffectNetConnect:  "network_connect",
		coreir.EffectNetFetch:    "network_fetch",
		coreir.EffectProcessExec: "process_exec",
		coreir.EffectRNGSample:   "rng_sample",
	}
	for _, effect := range f.Effects {
		if _, ok := wantCaps[effect]; !ok {
			return fmt.Errorf("unsupported native process effect %q", effect)
		}
	}
	for _, cap := range f.RequiredCapabilities {
		want, ok := wantCaps[cap.Effect]
		if !ok || cap.Name != want {
			return fmt.Errorf("unsupported native process capability %q for effect %q", cap.Name, cap.Effect)
		}
	}
	return nil
}

func x64NativeCallType(t coreir.Type, allowFP bool) bool {
	return t == coreir.I64 || t == coreir.U64 || t == coreir.Bool || (allowFP && t == coreir.IEEE64)
}

func compileX64LeafIR(sourcePath, entry string) (x64LeafIRArtifact, error) {
	module, err := compileX64ModuleIR(sourcePath, entry)
	if err != nil {
		return x64LeafIRArtifact{}, err
	}
	return x64LeafIRArtifact{
		Function: module.Entry,
		SSA:      module.EntrySSA,
		Plan:     module.EntryPlan,
		Symbol:   module.EntrySymbol,
	}, nil
}

func compileX64Leaf(sourcePath, entry string) (x64LeafArtifact, error) {
	ir, err := compileX64LeafIR(sourcePath, entry)
	if err != nil {
		return x64LeafArtifact{}, err
	}
	assembly, err := coreir.EmitX64LeafSSA(ir.SSA, ir.Plan)
	if err != nil {
		return x64LeafArtifact{}, err
	}
	return x64LeafArtifact{
		Assembly: assembly,
		Function: ir.Function,
		SSA:      ir.SSA,
		Plan:     ir.Plan,
		Symbol:   ir.Symbol,
	}, nil
}

func compileX64CFG(sourcePath, entry string) (x64LeafArtifact, error) {
	ir, err := compileX64ModuleIR(sourcePath, entry)
	if err != nil {
		return x64LeafArtifact{}, err
	}
	assembly, err := coreir.EmitX64SSAModule(ir.Functions, ir.Plans)
	if err != nil {
		return x64LeafArtifact{}, err
	}
	return x64LeafArtifact{
		Assembly: assembly,
		Function: ir.Entry,
		SSA:      ir.EntrySSA,
		Plan:     ir.EntryPlan,
		Symbol:   ir.EntrySymbol,
	}, nil
}

func coreX64Command(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "leaf entry function")
	output := flags.String("o", "", "new GAS Intel-syntax assembly file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64 -entry fn -o new.s file.swyp")
	}
	artifact, err := compileX64CFG(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, artifact.Assembly); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created direct x86-64 assembly %s (%s)\n", *output, coreir.X64CFGABI)
	return nil
}
