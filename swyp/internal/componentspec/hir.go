package componentspec

import "swyp-lang/internal/hir"

// HIRDeclarations converts declarative component specs into the same qualified
// declaration envelope used by executable Swyp modules. Existing component
// validation remains authoritative during the staged M1 migration.
func (m Manifest) HIRDeclarations() (hir.Module, error) {
	if err := m.Validate(); err != nil {
		return hir.Module{}, err
	}
	if m.Module == "" {
		return hir.Module{}, &hirModuleError{"HIR requires an explicit module declaration"}
	}
	out := hir.Module{Version: hir.Version, Name: m.Module, Uses: append([]string(nil), m.Uses...)}
	for _, d := range m.Declarations {
		decl := hir.Declaration{ID: hir.SymbolID{Module: m.Module, Kind: d.Kind, Name: d.Name}}
		if len(d.Fields) > 0 {
			decl.Fields = make([]hir.Field, 0, len(d.Fields))
			for _, f := range d.Fields {
				decl.Fields = append(decl.Fields, hir.Field{Name: f.Name, Type: hir.TypeRef{Name: f.Type}})
			}
		}
		states := make([]hir.Field, 0, len(d.States))
		for _, s := range d.States {
			states = append(states, hir.Field{Name: s.Name, Type: hir.TypeRef{Name: s.Type}})
		}
		decl.Declarative = &hir.Declarative{
			Base:         d.Base,
			Dataset:      d.Dataset,
			Capabilities: append([]string(nil), d.Capabilities...),
			Effects:      append([]string(nil), d.Effects...),
			States:       states,
			Requires:     append([]string(nil), d.Requires...),
			Ensures:      append([]string(nil), d.Ensures...),
			Invariants:   append([]string(nil), d.Invariants...),
			Checks:       append([]string(nil), d.Checks...),
			Forbids:      append([]string(nil), d.Forbids...),
			Verifiers:    append([]string(nil), d.Verifiers...),
			Properties:   cloneProperties(d.Properties),
		}
		out.Declarations = append(out.Declarations, decl)
	}
	if err := out.Validate(); err != nil {
		return hir.Module{}, err
	}
	return out, nil
}

type hirModuleError struct{ message string }

func (e *hirModuleError) Error() string { return e.message }

func cloneProperties(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
