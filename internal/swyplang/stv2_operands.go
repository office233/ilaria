package swyplang

// stv2Operand distinguishes a disposable expression temporary from a borrowed
// live variable/input register. It is compiler-internal register ownership, not
// a source-language memory/borrow system.
type stv2Operand struct {
	reg       uint8
	temporary bool
}

// operand borrows only leaves that are read-only for the duration of expression
// evaluation. Preflight permits arg() as the only call, and reserves immutable
// input registers. If effectful calls are added, these assumptions need review.
// Composite expressions still evaluate left-to-right into owned temporaries;
// arithmetic checks and short-circuit control flow are not removed or reordered.
func (l *stv2Lowerer) operand(e *expr) stv2Operand {
	switch e.kind {
	case "variable":
		return stv2Operand{reg: l.lookup(e.name, e.pos)}
	case "call":
		index, _ := stv2Literal(e.args[0]) // validated by whole-program preflight
		return stv2Operand{reg: uint8(index)}
	default:
		return stv2Operand{reg: l.expression(e), temporary: true}
	}
}

func (l *stv2Lowerer) releaseOperand(v stv2Operand) {
	if v.temporary {
		l.free(v.reg)
	}
}
