package coreir

import "encoding/json"

// Constraints owns a validated contract snapshot. It evaluates relations directly;
// it does not invent a unique expected output from an arbitrary postcondition.
// Concurrent checks use fresh environments. Construction is bounded by the same
// predicate limits as Verify; callers must not mutate inputs during construction.
type Constraints struct {
	contract Contract
	bounds   []interval
	result   Type
}

func PrepareConstraints(e *Executable, c Contract) (*Constraints, error) {
	if _, err := c.validate(e); err != nil {
		return nil, err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	copy, err := DecodeContract(data)
	if err != nil {
		return nil, err
	}
	bounds, err := copy.validate(e)
	if err != nil {
		return nil, err
	}
	_, result, err := e.Parameters(copy.Entry)
	if err != nil {
		return nil, err
	}
	return &Constraints{contract: copy, bounds: bounds, result: result}, nil
}

func (c *Constraints) environment(args []Value) (map[string]Value, bool, error) {
	if c == nil || len(args) != len(c.bounds) {
		return nil, false, diagnostic("invalid_contract_input", "constraint input arity mismatch")
	}
	env := make(map[string]Value, len(args)+1)
	for i, a := range args {
		if a.Type() != c.contract.Inputs[i].Type {
			return nil, false, diagnostic("invalid_contract_input", "constraint input type mismatch")
		}
		if !within(a, c.bounds[i]) {
			return nil, false, nil
		}
		env[c.contract.Inputs[i].Name] = a
	}
	for _, p := range c.contract.Requires {
		v, err := evalPredicate(p, env)
		if err != nil {
			return nil, false, contractDiagnostic("requires", err)
		}
		if !v.b {
			return nil, false, nil
		}
	}
	return env, true, nil
}

// Admissible checks types, the inclusive domain, and every precondition.
func (c *Constraints) Admissible(args []Value) (bool, error) {
	_, admissible, err := c.environment(args)
	return admissible, err
}

// Check rejects out-of-domain/nonadmissible inputs rather than returning vacuous
// success. Predicate evaluation errors remain errors, never false proofs.
func (c *Constraints) Check(args []Value, result Value) (bool, error) {
	env, admissible, err := c.environment(args)
	if err != nil || !admissible {
		return false, err
	}
	if result.Type() != c.result {
		return false, diagnostic("invalid_contract_input", "constraint result type mismatch")
	}
	env["result"] = result
	for _, p := range c.contract.Ensures {
		v, err := evalPredicate(p, env)
		if err != nil {
			return false, contractDiagnostic("ensures", err)
		}
		if !v.b {
			return false, nil
		}
	}
	return true, nil
}
