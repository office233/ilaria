package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

func compileARM64CFG(sourcePath, entry string) ([]byte, error) {
	input, err := readModuleInput(sourcePath, coreir.MaxBytes)
	if err != nil {
		return nil, err
	}
	p, err := swyplang.ParseCore(sourcePath, string(input))
	if err != nil {
		return nil, err
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		return nil, err
	}
	m, _, err = coreir.Optimize(m)
	if err != nil {
		return nil, err
	}
	m, err = pruneARM64NativeModule(m, entry)
	if err != nil {
		return nil, err
	}
	if err := validateARM64NativeModule(m, entry); err != nil {
		return nil, err
	}
	functions := make([]coreir.SSAFunction, 0, len(m.Functions))
	plans := make(map[string]coreir.SSARegisterPlan, len(m.Functions))
	for i := range m.Functions {
		function := m.Functions[i]
		ssa, err := coreir.BuildSSA(function)
		if err != nil {
			return nil, fmt.Errorf("arm64 %s SSA: %w", function.Name, err)
		}
		plan, err := coreir.AllocateSSARegisters(ssa, coreir.ARM64LeafRegisterCount(), coreir.ARM64FPRegisterCount())
		if err != nil {
			return nil, fmt.Errorf("arm64 %s register allocation: %w", function.Name, err)
		}
		functions = append(functions, ssa)
		plans[function.Name] = plan
	}
	return coreir.EmitARM64SSAModule(functions, plans)
}

func pruneARM64NativeModule(m coreir.Module, entry string) (coreir.Module, error) {
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
			return fmt.Errorf("arm64 native module references unknown function %q", name)
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
		return coreir.Module{}, fmt.Errorf("arm64 native pruning produced invalid module: %w", err)
	}
	return m, nil
}

func validateARM64NativeModule(m coreir.Module, entry string) error {
	return validateARM64NativeModuleMode(m, entry, false, false)
}

func validateARM64NativeModuleMode(m coreir.Module, entry string, allowFPCalls, allowProcessIO bool) error {
	functions := make(map[string]coreir.Function, len(m.Functions))
	for _, f := range m.Functions {
		if f.Result == coreir.Bytes && (!allowProcessIO || f.Name == entry) {
			return fmt.Errorf("arm64 native backend function %s: bytes result requires byte arena support", f.Name)
		}
		for i, param := range f.Params {
			if param.Type == coreir.Bytes && (!allowProcessIO || f.Name == entry) {
				return fmt.Errorf("arm64 native backend function %s: bytes parameter %d requires byte arena support", f.Name, i)
			}
		}
		for bi, block := range f.Blocks {
			for ii, ins := range block.Instructions {
				if (ins.Op == "bytes.get" || ins.Op == "bytes.from_storage_u64") && !allowProcessIO {
					return fmt.Errorf("arm64 native backend function %s block %d instruction %d: %s requires native byte-arena mapping", f.Name, bi, ii, ins.Op)
				}
			}
		}
		if err := validateNativeProcessEffects(f, allowProcessIO); err != nil {
			return fmt.Errorf("arm64 native backend function %s: %w", f.Name, err)
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
			return fmt.Errorf("arm64 native backend does not support recursive call cycle at %s", name)
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
					return fmt.Errorf("arm64 native call from %s to unknown %s", name, ins.Callee)
				}
				gprArgs, fpArgs := 0, 0
				for _, param := range callee.Params {
					if param.Type == coreir.IEEE64 && allowFPCalls {
						fpArgs++
					} else {
						gprArgs++
					}
				}
				if len(ins.Args) != len(callee.Params) || gprArgs > 7 || fpArgs > 8 {
					return fmt.Errorf("arm64 native call %s -> %s exceeds argument registers", name, ins.Callee)
				}
				if !arm64NativeCallType(callee.Result, allowFPCalls) && !(allowProcessIO && callee.Result == coreir.Bytes) {
					return fmt.Errorf("arm64 native call %s -> %s result type %s is unsupported", name, ins.Callee, callee.Result)
				}
				for i, param := range callee.Params {
					if !arm64NativeCallType(param.Type, allowFPCalls) && !(allowProcessIO && param.Type == coreir.Bytes) {
						return fmt.Errorf("arm64 native call %s -> %s argument %d type %s is unsupported", name, ins.Callee, i, param.Type)
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

func arm64NativeCallType(t coreir.Type, allowFP bool) bool {
	return t == coreir.I64 || t == coreir.U64 || t == coreir.Bool || (allowFP && t == coreir.IEEE64)
}

func coreARM64Command(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-arm64", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function")
	output := flags.String("o", "", "new AArch64 assembly file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-arm64 -entry fn -o new.s file.swyp")
	}
	assembly, err := compileARM64CFG(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, assembly); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created direct ARM64 assembly %s (%s)\n", *output, coreir.ARM64CFGABI)
	return nil
}
