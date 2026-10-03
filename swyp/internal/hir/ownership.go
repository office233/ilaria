package hir

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const OwnershipVersion = 1

type OwnershipClass string

const (
	OwnershipCopy     OwnershipClass = "copy"
	OwnershipMove     OwnershipClass = "move"
	OwnershipBorrowed OwnershipClass = "borrowed"
)

type OwnershipReport struct {
	Version     int                   `json:"version"`
	Root        string                `json:"root"`
	Status      string                `json:"status"`
	Functions   []FunctionOwnership   `json:"functions"`
	Diagnostics []OwnershipDiagnostic `json:"diagnostics,omitempty"`
}

type FunctionOwnership struct {
	Function string `json:"function"`
	Status   string `json:"status"`
}

type OwnershipDiagnostic struct {
	Code     string   `json:"code"`
	Function string   `json:"function"`
	Message  string   `json:"message"`
	Location Location `json:"location,omitempty"`
}

// AnalyzeOwnership performs the first affine ownership gate over linked HIR.
// It deliberately supports a smaller sound subset than the type checker:
//   - Copy values may be read repeatedly.
//   - Move values are consumed by value use and must be consumed exactly once.
//   - slice<T> and aggregates containing a slice are Borrowed and cannot escape
//     a function until lifetime parameters are part of the language.
//   - moving out of indexed/field projections and ownership-changing loops are
//     rejected until partial-move and loop-invariant rules are specified.
//
// This checker does not lower ownership into machine IR. Its output is explicit
// evidence for promoting HIR programs into the future resource-safe Core.
func AnalyzeOwnership(bundle Bundle) (OwnershipReport, error) {
	if err := bundle.Validate(); err != nil {
		return OwnershipReport{}, fmt.Errorf("validate HIR bundle: %w", err)
	}
	types, err := BuildTypeTable(bundle.Modules)
	if err != nil {
		return OwnershipReport{}, err
	}
	functions, err := BuildFunctionTable(bundle.Modules)
	if err != nil {
		return OwnershipReport{}, err
	}
	report := OwnershipReport{Version: OwnershipVersion, Root: bundle.Root, Status: "ok"}
	for _, module := range bundle.Modules {
		for _, decl := range module.Declarations {
			if decl.Function == nil {
				continue
			}
			checker := ownershipChecker{
				module:    module.Name,
				function:  decl.ID.Canonical(),
				types:     types,
				functions: functions,
			}
			checker.checkFunction(*decl.Function)
			status := "ok"
			if len(checker.diagnostics) != 0 {
				status = "error"
				report.Status = "error"
				report.Diagnostics = append(report.Diagnostics, checker.diagnostics...)
			}
			report.Functions = append(report.Functions, FunctionOwnership{Function: decl.ID.Canonical(), Status: status})
		}
	}
	sort.Slice(report.Functions, func(i, j int) bool { return report.Functions[i].Function < report.Functions[j].Function })
	sort.SliceStable(report.Diagnostics, func(i, j int) bool {
		a, b := report.Diagnostics[i], report.Diagnostics[j]
		if a.Function != b.Function {
			return a.Function < b.Function
		}
		if a.Location.File != b.Location.File {
			return a.Location.File < b.Location.File
		}
		if a.Location.Line != b.Location.Line {
			return a.Location.Line < b.Location.Line
		}
		if a.Location.Column != b.Location.Column {
			return a.Location.Column < b.Location.Column
		}
		return a.Code < b.Code
	})
	return report, nil
}

func OwnershipOf(types TypeTable, currentModule string, typ TypeRef) (OwnershipClass, error) {
	return ownershipOf(types, currentModule, typ, map[string]bool{})
}

func ownershipOf(types TypeTable, currentModule string, typ TypeRef, visiting map[string]bool) (OwnershipClass, error) {
	if err := ValidateTypeRef(typ); err != nil {
		return "", err
	}
	switch typ.Name {
	case "void":
		return "", fmt.Errorf("void has no ownership class")
	case "bool", "bytes", "number",
		"i8", "i16", "i32", "i64", "i128",
		"u8", "u16", "u32", "u64", "u128",
		"f16", "bf16", "f32", "f64", "finite32", "finite64", "ieee64":
		return OwnershipCopy, nil
	case "string", "vec", "opaque":
		return OwnershipMove, nil
	case "slice", "ref", "mutref":
		return OwnershipBorrowed, nil
	case "array", "option", "result", "tuple":
		return aggregateOwnership(types, currentModule, typ.Args, visiting)
	}
	symbol, ok := ResolveType(types, currentModule, typ)
	if !ok {
		return "", fmt.Errorf("unknown ownership type %s", typ.String())
	}
	key := symbol.ID.Module + "." + symbol.ID.Name
	if visiting[key] {
		return "", fmt.Errorf("recursive-by-value ownership type %s", key)
	}
	visiting[key] = true
	defer delete(visiting, key)
	var members []TypeRef
	switch symbol.ID.Kind {
	case "struct", "record":
		for _, field := range symbol.Fields {
			members = append(members, field.Type)
		}
	case "enum":
		for _, variant := range symbol.Variants {
			if variant.Payload != nil {
				members = append(members, *variant.Payload)
			}
		}
	default:
		return "", fmt.Errorf("type %s kind %s has no ownership class", typ.String(), symbol.ID.Kind)
	}
	return aggregateOwnership(types, symbol.ID.Module, members, visiting)
}

func aggregateOwnership(types TypeTable, module string, members []TypeRef, visiting map[string]bool) (OwnershipClass, error) {
	class := OwnershipCopy
	for _, member := range members {
		memberClass, err := ownershipOf(types, module, member, visiting)
		if err != nil {
			return "", err
		}
		if memberClass == OwnershipBorrowed {
			class = OwnershipBorrowed
			continue
		}
		if memberClass == OwnershipMove && class != OwnershipBorrowed {
			class = OwnershipMove
		}
	}
	return class, nil
}

type ownershipVar struct {
	typ           TypeRef
	class         OwnershipClass
	moved         bool
	released      bool
	sharedBorrows int
	mutableBorrow bool
	sharedPlaces  map[string]int
	mutablePlaces map[string]int
	borrowOrigin  string
	borrowRoot    string
	borrowPlace   string
	borrowMut     bool
	deferredDrop  bool
	declared      Location
}

type ownershipScope struct {
	vars   map[string]*ownershipVar
	order  []string
	parent *ownershipScope
}

func (s *ownershipScope) lookup(name string) (*ownershipVar, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if value, ok := cur.vars[name]; ok {
			return value, true
		}
	}
	return nil, false
}

func cloneOwnershipScope(s *ownershipScope) *ownershipScope {
	if s == nil {
		return nil
	}
	parent := cloneOwnershipScope(s.parent)
	out := &ownershipScope{vars: make(map[string]*ownershipVar, len(s.vars)), order: append([]string(nil), s.order...), parent: parent}
	for name, value := range s.vars {
		copyValue := *value
		copyValue.sharedPlaces = cloneBorrowPlaces(value.sharedPlaces)
		copyValue.mutablePlaces = cloneBorrowPlaces(value.mutablePlaces)
		out.vars[name] = &copyValue
	}
	return out
}

func cloneBorrowPlaces(in map[string]int) map[string]int {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]int, len(in))
	for place, count := range in {
		out[place] = count
	}
	return out
}

type ownershipChecker struct {
	module      string
	function    string
	types       TypeTable
	functions   FunctionTable
	borrowFrom  string
	diagnostics []OwnershipDiagnostic
}

func (c *ownershipChecker) diagnostic(code, message string, location Location) {
	c.diagnostics = append(c.diagnostics, OwnershipDiagnostic{Code: code, Function: c.function, Message: message, Location: location})
}

func (c *ownershipChecker) class(typ TypeRef, loc Location) OwnershipClass {
	class, err := OwnershipOf(c.types, c.module, typ)
	if err != nil {
		c.diagnostic("ownership_type", err.Error(), loc)
		return OwnershipMove
	}
	return class
}

func (c *ownershipChecker) checkFunction(f Function) {
	c.borrowFrom = f.BorrowFrom
	root := &ownershipScope{vars: map[string]*ownershipVar{}}
	for _, param := range f.Params {
		class := c.class(param.Type, Location{})
		value := &ownershipVar{typ: param.Type, class: class, borrowMut: param.Type.Name == "mutref"}
		if class == OwnershipBorrowed {
			value.borrowRoot = param.Name
		}
		root.vars[param.Name] = value
		root.order = append(root.order, param.Name)
	}
	terminated := c.checkStatements(f.Body, root)
	if !terminated {
		c.requireConsumed(root, Location{})
	}
	if resultClass := c.classResult(f.Result); resultClass == OwnershipBorrowed {
		if f.BorrowFrom == "" {
			c.diagnostic("borrowed_result", fmt.Sprintf("function result %s is borrowed but has no lifetime contract", f.Result.String()), Location{})
		} else if source, ok := root.lookup(f.BorrowFrom); !ok || source.class != OwnershipBorrowed {
			c.diagnostic("lifetime_source", fmt.Sprintf("borrow lifetime source %s is not a borrowed parameter", f.BorrowFrom), Location{})
		}
	}
}

func (c *ownershipChecker) classResult(typ TypeRef) OwnershipClass {
	if typ.Name == "void" {
		return OwnershipCopy
	}
	return c.class(typ, Location{})
}

func (c *ownershipChecker) checkStatements(body []Statement, parent *ownershipScope) bool {
	scope := &ownershipScope{vars: map[string]*ownershipVar{}, parent: parent}
	terminated := false
	for _, stmt := range body {
		if terminated {
			break
		}
		switch stmt.Kind {
		case "let":
			if stmt.Type != nil {
				value := &ownershipVar{typ: *stmt.Type, class: c.class(*stmt.Type, stmt.Location), declared: stmt.Location}
				if stmt.Value != nil && value.class == OwnershipBorrowed {
					c.bindBorrowedValue(*stmt.Value, scope, value, stmt.Location)
				} else if stmt.Value != nil {
					c.consumeExpression(*stmt.Value, scope, consumeValue)
				}
				scope.vars[stmt.Name] = value
				scope.order = append(scope.order, stmt.Name)
			} else if stmt.Value != nil {
				c.consumeExpression(*stmt.Value, scope, consumeValue)
			}
		case "assign":
			value, ok := scope.lookup(stmt.Name)
			if !ok {
				continue
			}
			if value.class == OwnershipBorrowed {
				c.diagnostic("borrow_reassign", fmt.Sprintf("reassigning borrowed binding %s is not supported by ownership v1", stmt.Name), stmt.Location)
				if stmt.Value != nil {
					c.consumeExpression(*stmt.Value, scope, inspectValue)
				}
				continue
			}
			if value.deferredDrop {
				c.diagnostic("assign_after_defer_drop", fmt.Sprintf("cannot assign %s after defer_drop was scheduled", stmt.Name), stmt.Location)
			}
			if value.sharedBorrows != 0 || value.mutableBorrow {
				c.diagnostic("assign_while_borrowed", fmt.Sprintf("cannot assign %s while it is borrowed", stmt.Name), stmt.Location)
			}
			if value.class == OwnershipMove && !value.moved {
				c.diagnostic("implicit_drop", fmt.Sprintf("assignment to %s would implicitly drop live move value", stmt.Name), stmt.Location)
			}
			if stmt.Value != nil {
				c.consumeExpression(*stmt.Value, scope, consumeValue)
			}
			value.moved = false
		case "expr":
			if stmt.Value != nil {
				result := c.consumeExpression(*stmt.Value, scope, consumeValue)
				if result == OwnershipMove {
					c.diagnostic("implicit_drop", "discarding a move value requires explicit drop semantics", stmt.Location)
				}
			}
		case "return":
			if stmt.Value != nil {
				class := c.consumeExpression(*stmt.Value, scope, consumeValue)
				if class == OwnershipBorrowed {
					root := c.borrowRootOf(*stmt.Value, scope)
					if c.borrowFrom == "" {
						c.diagnostic("borrow_escape", "returning a borrowed value requires an explicit lifetime contract", stmt.Location)
					} else if root != c.borrowFrom {
						c.diagnostic("lifetime_mismatch", fmt.Sprintf("borrowed return originates from %q, lifetime contract requires %q", root, c.borrowFrom), stmt.Location)
					}
				}
			}
			c.requireConsumed(scope, stmt.Location)
			terminated = true
		case "if":
			if stmt.Value != nil {
				c.consumeExpression(*stmt.Value, scope, inspectValue)
			}
			before := cloneOwnershipScope(scope)
			yes := cloneOwnershipScope(scope)
			no := cloneOwnershipScope(scope)
			yesTerminated := c.checkStatements(stmt.Body, yes)
			noTerminated := c.checkStatements(stmt.Else, no)
			if !yesTerminated || !noTerminated {
				c.mergeConditionalOwnership(scope, before, yes, no, yesTerminated, noTerminated, stmt.Location)
			}
			terminated = yesTerminated && noTerminated && len(stmt.Else) != 0
		case "while":
			if stmt.Value != nil {
				c.consumeExpression(*stmt.Value, scope, inspectValue)
			}
			before := cloneOwnershipScope(scope)
			bodyScope := cloneOwnershipScope(scope)
			_ = c.checkStatements(stmt.Body, bodyScope)
			c.rejectLoopOwnershipChanges(before, bodyScope, stmt.Location)
		}
	}
	if !terminated {
		c.requireConsumedLocals(scope, Location{})
	}
	return terminated
}

type consumeMode uint8

const (
	inspectValue consumeMode = iota
	consumeValue
)

func (c *ownershipChecker) consumeExpression(e Expression, scope *ownershipScope, mode consumeMode) OwnershipClass {
	class := OwnershipCopy
	if e.Type.Name != "void" {
		class = c.class(e.Type, e.Location)
	}
	switch e.Kind {
	case "variable":
		value, ok := scope.lookup(e.Name)
		if !ok {
			return class
		}
		if value.released {
			c.diagnostic("use_after_borrow_end", fmt.Sprintf("use of released borrowed binding %s", e.Name), e.Location)
		}
		if value.mutableBorrow {
			c.diagnostic("use_while_mutably_borrowed", fmt.Sprintf("cannot use %s directly while it is mutably borrowed", e.Name), e.Location)
		}
		if value.class == OwnershipMove {
			if value.moved {
				c.diagnostic("use_after_move", fmt.Sprintf("use of moved value %s", e.Name), e.Location)
			} else if mode == consumeValue {
				if value.deferredDrop {
					c.diagnostic("move_after_defer_drop", fmt.Sprintf("cannot move %s after defer_drop was scheduled", e.Name), e.Location)
					return value.class
				}
				if value.sharedBorrows != 0 || value.mutableBorrow {
					c.diagnostic("move_while_borrowed", fmt.Sprintf("cannot move %s while it is borrowed", e.Name), e.Location)
				}
				value.moved = true
			}
		}
		return value.class
	case "borrow":
		c.diagnostic("borrow_binding_required", "borrow expressions must be bound with let in ownership v1", e.Location)
		if len(e.Args) == 1 {
			c.consumeExpression(e.Args[0], scope, inspectValue)
		}
		return OwnershipBorrowed
	case "deref":
		if len(e.Args) == 1 {
			c.consumeExpression(e.Args[0], scope, inspectValue)
		}
		return class
	case "field":
		if len(e.Args) == 1 {
			fieldClass := class
			if fieldClass == OwnershipMove && mode == consumeValue {
				c.diagnostic("partial_move", fmt.Sprintf("moving field %s out of an aggregate is not supported by ownership v1", e.Name), e.Location)
				c.consumeExpression(e.Args[0], scope, inspectValue)
			} else {
				c.consumeExpression(e.Args[0], scope, inspectValue)
			}
		}
		return class
	case "index":
		if len(e.Args) == 2 {
			if class == OwnershipMove && mode == consumeValue {
				c.diagnostic("partial_move", "moving a non-Copy element out by index is not supported by ownership v1", e.Location)
			}
			c.consumeExpression(e.Args[0], scope, inspectValue)
			c.consumeExpression(e.Args[1], scope, inspectValue)
		}
		return class
	case "slice":
		if len(e.Args) == 3 {
			c.diagnostic("borrow_binding_required", "slice views must be bound with let in ownership v1", e.Location)
			c.consumeExpression(e.Args[0], scope, inspectValue)
			c.consumeExpression(e.Args[1], scope, inspectValue)
			c.consumeExpression(e.Args[2], scope, inspectValue)
		}
		return OwnershipBorrowed
	case "array":
		for _, arg := range e.Args {
			c.consumeExpression(arg, scope, consumeValue)
		}
	case "vec":
		for _, arg := range e.Args {
			c.consumeExpression(arg, scope, consumeValue)
		}
	case "struct":
		for _, field := range e.Fields {
			c.consumeExpression(field.Value, scope, consumeValue)
		}
	case "enum":
		for _, arg := range e.Args {
			c.consumeExpression(arg, scope, consumeValue)
		}
	case "match":
		if len(e.Args) == 1 {
			c.consumeExpression(e.Args[0], scope, consumeValue)
		}
		baseline := cloneOwnershipScope(scope)
		armStates := make([]*ownershipScope, 0, len(e.Arms))
		for _, arm := range e.Arms {
			armScope := &ownershipScope{vars: map[string]*ownershipVar{}, parent: cloneOwnershipScope(scope)}
			if arm.Binding != "" && arm.BindingType != nil {
				armScope.vars[arm.Binding] = &ownershipVar{typ: *arm.BindingType, class: c.class(*arm.BindingType, e.Location), declared: e.Location}
				armScope.order = append(armScope.order, arm.Binding)
			}
			c.consumeExpression(arm.Value, armScope, consumeValue)
			c.requireConsumedLocals(armScope, e.Location)
			armStates = append(armStates, armScope)
		}
		c.mergeMatchOwnership(scope, baseline, armStates, e.Location)
	case "call":
		if e.Builtin == "drop" {
			if len(e.Args) == 1 {
				if e.Args[0].Kind == "variable" {
					if value, ok := scope.lookup(e.Args[0].Name); ok && value.deferredDrop {
						c.diagnostic("drop_after_defer_drop", fmt.Sprintf("cannot drop %s explicitly after defer_drop was scheduled", e.Args[0].Name), e.Location)
						return OwnershipCopy
					}
					if value, ok := scope.lookup(e.Args[0].Name); ok && value.class == OwnershipBorrowed {
						c.releaseBorrow(value, scope, e.Args[0].Name, e.Location)
						return OwnershipCopy
					}
				}
				c.consumeExpression(e.Args[0], scope, consumeValue)
			}
			return OwnershipCopy
		}
		if e.Builtin == "defer_drop" {
			if len(e.Args) != 1 || e.Args[0].Kind != "variable" {
				c.diagnostic("defer_drop_target", "defer_drop requires a direct local variable", e.Location)
				return OwnershipCopy
			}
			name := e.Args[0].Name
			value, ok := scope.vars[name]
			if !ok && scope.parent != nil && scope.parent.parent == nil {
				// The first lexical body scope may schedule cleanup for a moved
				// function parameter. Nested blocks remain intentionally excluded so
				// cleanup scheduling cannot become branch-dependent in v1.
				value, ok = scope.parent.vars[name]
			}
			if !ok {
				c.diagnostic("defer_drop_scope", fmt.Sprintf("defer_drop target %s must be declared in the current lexical scope or be a top-level function parameter", name), e.Location)
				return OwnershipCopy
			}
			if value.class != OwnershipMove {
				c.diagnostic("defer_drop_class", fmt.Sprintf("defer_drop target %s is %s, expected move-owned value", name, value.class), e.Location)
				return OwnershipCopy
			}
			if value.moved {
				c.diagnostic("use_after_move", fmt.Sprintf("defer_drop of moved value %s", name), e.Location)
				return OwnershipCopy
			}
			if value.sharedBorrows != 0 || value.mutableBorrow {
				c.diagnostic("borrow_conflict", fmt.Sprintf("cannot schedule defer_drop for %s while borrowed", name), e.Location)
				return OwnershipCopy
			}
			if value.deferredDrop {
				c.diagnostic("duplicate_defer_drop", fmt.Sprintf("defer_drop already scheduled for %s", name), e.Location)
				return OwnershipCopy
			}
			value.deferredDrop = true
			return OwnershipCopy
		}
		if e.Builtin == "vec_push" {
			if len(e.Args) != 2 || e.Args[0].Kind != "variable" {
				c.diagnostic("vec_push_target", "vec_push requires a direct vec variable", e.Location)
				for _, arg := range e.Args {
					c.consumeExpression(arg, scope, inspectValue)
				}
				return OwnershipCopy
			}
			value, ok := scope.lookup(e.Args[0].Name)
			if ok {
				if value.moved {
					c.diagnostic("use_after_move", fmt.Sprintf("vec_push of moved value %s", e.Args[0].Name), e.Location)
				}
				if value.sharedBorrows != 0 || value.mutableBorrow {
					c.diagnostic("borrow_conflict", fmt.Sprintf("cannot mutate vec %s while borrowed", e.Args[0].Name), e.Location)
				}
			}
			c.consumeExpression(e.Args[0], scope, inspectValue)
			c.consumeExpression(e.Args[1], scope, consumeValue)
			return OwnershipCopy
		}
		if e.Builtin == "store" {
			if len(e.Args) == 2 {
				if e.Args[0].Kind == "variable" {
					if value, ok := scope.lookup(e.Args[0].Name); ok {
						if value.released {
							c.diagnostic("use_after_borrow_end", fmt.Sprintf("store through released borrow %s", e.Args[0].Name), e.Location)
						}
						if !value.borrowMut && value.typ.Name != "mutref" {
							c.diagnostic("store_requires_mutref", "store requires a mutable borrow", e.Location)
						}
						if value.sharedBorrows != 0 || value.mutableBorrow {
							c.diagnostic("borrow_conflict", fmt.Sprintf("cannot store through %s while a derived borrow is active", e.Args[0].Name), e.Location)
						}
					}
				}
				c.consumeExpression(e.Args[0], scope, inspectValue)
				c.consumeExpression(e.Args[1], scope, inspectValue)
			}
			return OwnershipCopy
		}
		if e.Callee != nil {
			if symbol, ok := c.functions[e.Callee.Canonical()]; ok {
				exclusive := map[*ownershipVar]int{}
				for i, arg := range e.Args {
					if arg.Kind == "borrow" || arg.Kind == "slice" {
						c.diagnostic("borrow_binding_required", "borrowed call arguments must be bound with let in ownership v1", arg.Location)
					}
					argMode := inspectValue
					if i < len(symbol.Signature.Params) && c.class(symbol.Signature.Params[i].Type, arg.Location) == OwnershipMove {
						argMode = consumeValue
					}
					if i < len(symbol.Signature.Params) && symbol.Signature.Params[i].Type.Name == "mutref" && arg.Kind == "variable" {
						if loan, ok := scope.lookup(arg.Name); ok {
							// Loan construction already checks overlapping provenance.
							// One exclusive binding cannot fill two simultaneous inputs.
							if previous, exists := exclusive[loan]; exists {
								c.diagnostic("exclusive_call_alias", fmt.Sprintf("call to %s arguments %d and %d reuse exclusive mutable loan %s", e.Callee.Canonical(), previous+1, i+1, arg.Name), arg.Location)
							} else {
								exclusive[loan] = i
							}
						}
					}
					c.consumeExpression(arg, scope, argMode)
				}
				return class
			}
		}
		for _, arg := range e.Args {
			c.consumeExpression(arg, scope, inspectValue)
		}
	case "unary", "binary":
		for _, arg := range e.Args {
			c.consumeExpression(arg, scope, inspectValue)
		}
	}
	return class
}

func (c *ownershipChecker) borrowRootOf(e Expression, scope *ownershipScope) string {
	switch e.Kind {
	case "variable":
		value, ok := scope.lookup(e.Name)
		if !ok || value.class != OwnershipBorrowed {
			return ""
		}
		if value.borrowRoot != "" {
			return value.borrowRoot
		}
		return e.Name
	case "borrow", "slice":
		if len(e.Args) == 0 || e.Args[0].Kind != "variable" {
			return ""
		}
		value, ok := scope.lookup(e.Args[0].Name)
		if !ok {
			return ""
		}
		if value.class == OwnershipBorrowed && value.borrowRoot != "" {
			return value.borrowRoot
		}
		return ""
	case "call":
		if e.Callee == nil {
			return ""
		}
		symbol, ok := c.functions[e.Callee.Canonical()]
		if !ok || symbol.Signature.BorrowFrom == "" {
			return ""
		}
		for i, param := range symbol.Signature.Params {
			if param.Name == symbol.Signature.BorrowFrom && i < len(e.Args) {
				return c.borrowRootOf(e.Args[i], scope)
			}
		}
		return ""
	default:
		return ""
	}
}

func (c *ownershipChecker) requireConsumed(scope *ownershipScope, loc Location) {
	for cur := scope; cur != nil; cur = cur.parent {
		c.requireConsumedLocals(cur, loc)
	}
}

func (c *ownershipChecker) requireConsumedLocals(scope *ownershipScope, loc Location) {
	if scope == nil {
		return
	}
	for i := len(scope.order) - 1; i >= 0; i-- {
		name := scope.order[i]
		value := scope.vars[name]
		if value != nil && value.class == OwnershipBorrowed && value.borrowOrigin != "" && !value.released {
			c.releaseBorrow(value, scope, name, loc)
		}
	}
	names := append([]string(nil), scope.order...)
	sort.Strings(names)
	for _, name := range names {
		value := scope.vars[name]
		if value.class == OwnershipMove && !value.moved {
			if value.deferredDrop {
				value.moved = true
				continue
			}
			location := loc
			if location.Line == 0 {
				location = value.declared
			}
			c.diagnostic("implicit_drop", fmt.Sprintf("move value %s reaches scope end without consumption", name), location)
		}
	}
}

func (c *ownershipChecker) bindBorrowedValue(e Expression, scope *ownershipScope, target *ownershipVar, loc Location) {
	switch e.Kind {
	case "borrow":
		if len(e.Args) != 1 {
			c.diagnostic("borrow_source", "borrow v1 requires one place operand", loc)
			return
		}
		originName, ok := borrowPlaceRoot(e.Args[0])
		if !ok {
			c.diagnostic("borrow_source", "borrow v1 requires a variable/field/index place rooted in a local variable", loc)
			return
		}
		origin, ok := scope.lookup(originName)
		if !ok {
			return
		}
		c.inspectBorrowPlace(e.Args[0], scope)
		place := borrowPlacePath(e.Args[0])
		c.beginBorrow(origin, originName, place, e.Operator == "mut", loc)
		target.borrowOrigin = originName
		target.borrowRoot = c.borrowRootFor(origin, originName)
		target.borrowPlace = place
		target.borrowMut = e.Operator == "mut"
	case "slice":
		if len(e.Args) != 3 {
			c.diagnostic("borrow_source", "slice borrow v1 requires base/start/end operands", loc)
			return
		}
		originName, ok := borrowPlaceRoot(e.Args[0])
		if !ok {
			c.diagnostic("borrow_source", "slice borrow v1 requires a variable/field/index place rooted in a local variable", loc)
			return
		}
		origin, ok := scope.lookup(originName)
		if !ok {
			return
		}
		c.inspectBorrowPlace(e.Args[0], scope)
		place := borrowSlicePlacePath(e)
		c.beginBorrow(origin, originName, place, false, loc)
		target.borrowOrigin = originName
		target.borrowRoot = c.borrowRootFor(origin, originName)
		target.borrowPlace = place
		c.consumeExpression(e.Args[1], scope, inspectValue)
		c.consumeExpression(e.Args[2], scope, inspectValue)
	case "variable":
		origin, ok := scope.lookup(e.Name)
		if !ok {
			return
		}
		if origin.typ.Name == "mutref" || origin.borrowMut {
			c.diagnostic("mutref_copy", fmt.Sprintf("mutable borrow %s cannot be copied; create an explicit reborrow", e.Name), loc)
			return
		}
		c.beginBorrow(origin, e.Name, "", false, loc)
		target.borrowOrigin = e.Name
		target.borrowRoot = c.borrowRootFor(origin, e.Name)
		target.borrowPlace = ""
	case "call":
		if e.Callee == nil {
			c.diagnostic("borrow_provenance", "borrowed call result is missing callee provenance", loc)
			return
		}
		symbol, ok := c.functions[e.Callee.Canonical()]
		if !ok || symbol.Signature.BorrowFrom == "" {
			c.diagnostic("borrow_provenance", fmt.Sprintf("borrowed call result from %s has no lifetime contract", e.Callee.Canonical()), loc)
			return
		}
		borrowIndex := -1
		for i, param := range symbol.Signature.Params {
			if param.Name == symbol.Signature.BorrowFrom {
				borrowIndex = i
				break
			}
		}
		if borrowIndex < 0 || borrowIndex >= len(e.Args) || e.Args[borrowIndex].Kind != "variable" {
			c.diagnostic("borrow_provenance", "lifetime-bound call argument must be a direct borrowed variable in ownership v1", loc)
			return
		}
		originName := e.Args[borrowIndex].Name
		origin, ok := scope.lookup(originName)
		if !ok || origin.class != OwnershipBorrowed {
			c.diagnostic("borrow_provenance", fmt.Sprintf("lifetime-bound call argument %s is not a borrowed binding", originName), loc)
			return
		}
		mutable := target.typ.Name == "mutref"
		c.beginBorrow(origin, originName, "", mutable, loc)
		target.borrowOrigin = originName
		target.borrowRoot = c.borrowRootFor(origin, originName)
		target.borrowPlace = ""
		target.borrowMut = mutable
	default:
		c.diagnostic("borrow_provenance", "borrowed values must originate from a direct lexical borrow/slice binding in ownership v1", loc)
	}
}

func borrowPlaceRoot(e Expression) (string, bool) {
	switch e.Kind {
	case "variable":
		return e.Name, e.Name != ""
	case "field":
		if len(e.Args) == 1 {
			return borrowPlaceRoot(e.Args[0])
		}
	case "index":
		if len(e.Args) == 2 {
			return borrowPlaceRoot(e.Args[0])
		}
	case "slice":
		if len(e.Args) == 3 {
			return borrowPlaceRoot(e.Args[0])
		}
	}
	return "", false
}

func borrowPlacePath(e Expression) string {
	switch e.Kind {
	case "variable":
		return ""
	case "field":
		if len(e.Args) == 1 {
			base := borrowPlacePath(e.Args[0])
			return base + "." + e.Name
		}
	case "index":
		if len(e.Args) == 2 {
			base := borrowPlacePath(e.Args[0])
			if index, ok := constantU64Index(e.Args[1]); ok {
				return base + "[" + strconv.FormatUint(index, 10) + "]"
			}
			// A dynamic index borrows the whole indexed container. For x.field[i],
			// this is still disjoint from x.otherField; for x[i] it is whole-owner.
			return base
		}
	case "slice":
		if len(e.Args) == 3 {
			return borrowSlicePlacePath(e)
		}
	}
	return ""
}

func borrowSlicePlacePath(e Expression) string {
	if e.Kind != "slice" || len(e.Args) != 3 {
		return ""
	}
	base := borrowPlacePath(e.Args[0])
	start, startOK := constantU64Index(e.Args[1])
	end, endOK := constantU64Index(e.Args[2])
	if !startOK || !endOK || start > end {
		// Dynamic or invalid-at-runtime ranges conservatively borrow the whole
		// base container. Runtime bounds validation remains a separate gate.
		return base
	}
	return base + "[" + strconv.FormatUint(start, 10) + ":" + strconv.FormatUint(end, 10) + "]"
}

func constantU64Index(e Expression) (uint64, bool) {
	if e.Kind != "literal" || e.Type.Name != "u64" || e.Literal == nil || e.Literal.Kind != "number" {
		return 0, false
	}
	value, err := strconv.ParseUint(strings.ReplaceAll(e.Literal.Value, "_", ""), 10, 64)
	return value, err == nil
}

func (c *ownershipChecker) inspectBorrowPlace(e Expression, scope *ownershipScope) {
	switch e.Kind {
	case "field":
		if len(e.Args) == 1 {
			c.inspectBorrowPlace(e.Args[0], scope)
		}
	case "index":
		if len(e.Args) == 2 {
			c.inspectBorrowPlace(e.Args[0], scope)
			c.consumeExpression(e.Args[1], scope, inspectValue)
		}
	}
}

func (c *ownershipChecker) borrowRootFor(origin *ownershipVar, name string) string {
	if origin == nil {
		return ""
	}
	if origin.class == OwnershipBorrowed {
		if origin.borrowRoot != "" {
			return origin.borrowRoot
		}
		return name
	}
	return ""
}

func (c *ownershipChecker) beginBorrow(origin *ownershipVar, name, place string, mutable bool, loc Location) {
	if origin.released {
		c.diagnostic("borrow_after_end", fmt.Sprintf("cannot borrow released binding %s", name), loc)
		return
	}
	if origin.class == OwnershipMove && origin.moved {
		c.diagnostic("borrow_after_move", fmt.Sprintf("cannot borrow moved value %s", name), loc)
		return
	}
	if mutable {
		for other, count := range origin.sharedPlaces {
			if count > 0 && borrowPlacesOverlap(place, other) {
				c.diagnostic("borrow_conflict", fmt.Sprintf("cannot mutably borrow %s%s while overlapping shared borrow %s is active", name, place, displayBorrowPlace(other)), loc)
				return
			}
		}
		for other, count := range origin.mutablePlaces {
			if count > 0 && borrowPlacesOverlap(place, other) {
				c.diagnostic("borrow_conflict", fmt.Sprintf("cannot mutably borrow %s%s while overlapping mutable borrow %s is active", name, place, displayBorrowPlace(other)), loc)
				return
			}
		}
		if origin.mutablePlaces == nil {
			origin.mutablePlaces = map[string]int{}
		}
		origin.mutablePlaces[place]++
		origin.mutableBorrow = true
		return
	}
	for other, count := range origin.mutablePlaces {
		if count > 0 && borrowPlacesOverlap(place, other) {
			c.diagnostic("borrow_conflict", fmt.Sprintf("cannot immutably borrow %s%s while overlapping mutable borrow %s is active", name, place, displayBorrowPlace(other)), loc)
			return
		}
	}
	if origin.sharedPlaces == nil {
		origin.sharedPlaces = map[string]int{}
	}
	origin.sharedPlaces[place]++
	origin.sharedBorrows++
}

type borrowPlaceSegment struct {
	kind       byte // 'f' field, 'i' index, 'r' half-open range
	field      string
	index      uint64
	rangeStart uint64
	rangeEnd   uint64
}

func borrowPlacesOverlap(a, b string) bool {
	if a == "" || b == "" || a == b {
		return true
	}
	aSegments, aOK := parseBorrowPlace(a)
	bSegments, bOK := parseBorrowPlace(b)
	if !aOK || !bOK {
		// Any malformed internal place representation must fail conservative.
		return true
	}
	limit := len(aSegments)
	if len(bSegments) < limit {
		limit = len(bSegments)
	}
	for i := 0; i < limit; i++ {
		if !borrowSegmentsOverlap(aSegments[i], bSegments[i]) {
			return false
		}
	}
	// If all common segments overlap and one place is an ancestor of the other,
	// both places address the same aggregate/storage region.
	return true
}

func parseBorrowPlace(path string) ([]borrowPlaceSegment, bool) {
	segments := make([]borrowPlaceSegment, 0, 4)
	for at := 0; at < len(path); {
		switch path[at] {
		case '.':
			at++
			start := at
			for at < len(path) && path[at] != '.' && path[at] != '[' {
				at++
			}
			if start == at {
				return nil, false
			}
			segments = append(segments, borrowPlaceSegment{kind: 'f', field: path[start:at]})
		case '[':
			close := strings.IndexByte(path[at:], ']')
			if close < 0 {
				return nil, false
			}
			close += at
			content := path[at+1 : close]
			if colon := strings.IndexByte(content, ':'); colon >= 0 {
				start, errStart := strconv.ParseUint(content[:colon], 10, 64)
				end, errEnd := strconv.ParseUint(content[colon+1:], 10, 64)
				if errStart != nil || errEnd != nil || start > end {
					return nil, false
				}
				segments = append(segments, borrowPlaceSegment{kind: 'r', rangeStart: start, rangeEnd: end})
			} else {
				index, err := strconv.ParseUint(content, 10, 64)
				if err != nil {
					return nil, false
				}
				segments = append(segments, borrowPlaceSegment{kind: 'i', index: index})
			}
			at = close + 1
		default:
			return nil, false
		}
	}
	return segments, true
}

func borrowSegmentsOverlap(a, b borrowPlaceSegment) bool {
	if a.kind == 'f' || b.kind == 'f' {
		return a.kind == 'f' && b.kind == 'f' && a.field == b.field
	}
	switch {
	case a.kind == 'i' && b.kind == 'i':
		return a.index == b.index
	case a.kind == 'i' && b.kind == 'r':
		return b.rangeStart <= a.index && a.index < b.rangeEnd
	case a.kind == 'r' && b.kind == 'i':
		return a.rangeStart <= b.index && b.index < a.rangeEnd
	case a.kind == 'r' && b.kind == 'r':
		return a.rangeStart < b.rangeEnd && b.rangeStart < a.rangeEnd
	default:
		return true
	}
}

func displayBorrowPlace(place string) string {
	if place == "" {
		return "<whole-owner>"
	}
	return place
}

func (c *ownershipChecker) releaseBorrow(value *ownershipVar, scope *ownershipScope, name string, loc Location) {
	if value.released {
		return
	}
	if value.sharedBorrows != 0 || value.mutableBorrow {
		c.diagnostic("borrow_has_dependents", fmt.Sprintf("cannot end borrow %s while derived borrows are active", name), loc)
		return
	}
	if value.borrowOrigin != "" {
		origin, ok := scope.lookup(value.borrowOrigin)
		if ok {
			if value.borrowMut {
				if origin.mutablePlaces[value.borrowPlace] > 1 {
					origin.mutablePlaces[value.borrowPlace]--
				} else {
					delete(origin.mutablePlaces, value.borrowPlace)
				}
				origin.mutableBorrow = len(origin.mutablePlaces) != 0
			} else if origin.sharedBorrows > 0 {
				if origin.sharedPlaces[value.borrowPlace] > 1 {
					origin.sharedPlaces[value.borrowPlace]--
				} else {
					delete(origin.sharedPlaces, value.borrowPlace)
				}
				origin.sharedBorrows--
			}
		}
	}
	value.released = true
}

func (c *ownershipChecker) mergeConditionalOwnership(dst, before, yes, no *ownershipScope, yesTerminated, noTerminated bool, loc Location) {
	beforeVisible := visibleOwnership(before)
	yesVisible := visibleOwnership(yes)
	noVisible := visibleOwnership(no)
	for name, baseline := range beforeVisible {
		value, ok := dst.lookup(name)
		if !ok || baseline.class != OwnershipMove {
			continue
		}
		yesValue, yesOK := yesVisible[name]
		noValue, noOK := noVisible[name]
		if !yesOK || !noOK {
			continue
		}
		if yesTerminated {
			yesValue.moved = noValue.moved
		}
		if noTerminated {
			noValue.moved = yesValue.moved
		}
		if yesValue.moved != noValue.moved {
			c.diagnostic("conditional_move", fmt.Sprintf("move state of %s differs across if branches", name), loc)
			value.moved = true
		} else {
			value.moved = yesValue.moved
		}
	}
}

func (c *ownershipChecker) rejectLoopOwnershipChanges(before, after *ownershipScope, loc Location) {
	beforeVisible := visibleOwnership(before)
	afterVisible := visibleOwnership(after)
	for name, baseline := range beforeVisible {
		if baseline.class != OwnershipMove {
			continue
		}
		value, ok := afterVisible[name]
		if ok && value.moved != baseline.moved {
			c.diagnostic("loop_move", fmt.Sprintf("ownership state of %s changes across loop; loop ownership invariants are not implemented", name), loc)
		}
	}
}

func (c *ownershipChecker) mergeMatchOwnership(dst, baseline *ownershipScope, arms []*ownershipScope, loc Location) {
	if len(arms) == 0 {
		return
	}
	baseVisible := visibleOwnership(baseline)
	armVisible := make([]map[string]*ownershipVar, len(arms))
	for i, arm := range arms {
		armVisible[i] = visibleOwnership(arm)
	}
	for name, base := range baseVisible {
		if base.class != OwnershipMove {
			continue
		}
		first, ok := armVisible[0][name]
		if !ok {
			continue
		}
		moved := first.moved
		consistent := true
		for i := 1; i < len(armVisible); i++ {
			value, exists := armVisible[i][name]
			if !exists || value.moved != moved {
				consistent = false
				break
			}
		}
		dstValue, exists := dst.lookup(name)
		if !exists {
			continue
		}
		if !consistent {
			c.diagnostic("match_move", fmt.Sprintf("move state of %s differs across match arms", name), loc)
			dstValue.moved = true
		} else {
			dstValue.moved = moved
		}
	}
}

func visibleOwnership(scope *ownershipScope) map[string]*ownershipVar {
	out := map[string]*ownershipVar{}
	for cur := scope; cur != nil; cur = cur.parent {
		for name, value := range cur.vars {
			if _, exists := out[name]; !exists {
				out[name] = value
			}
		}
	}
	return out
}
