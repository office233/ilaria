package swypbroker

import (
	"context"
	"errors"
	"sync"
)

type policyKey struct {
	capability string
	target     string
	symbol     string
}

// PolicyResolver is an explicit host-side capability table. Grants are scoped
// to an exact logical capability + approved target + native symbol triple. There
// are intentionally no wildcard rules.
type PolicyResolver struct {
	mu     sync.RWMutex
	grants map[policyKey]Grant
}

func NewPolicyResolver() *PolicyResolver {
	return &PolicyResolver{grants: map[policyKey]Grant{}}
}

func (r *PolicyResolver) Grant(capability, target, symbol string, grant Grant) error {
	if !validCapabilityName(capability) || target == "" || symbol == "" || !grant.Valid() {
		return errors.New("invalid capability policy grant")
	}
	key := policyKey{capability: capability, target: target, symbol: symbol}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.grants == nil {
		r.grants = map[policyKey]Grant{}
	}
	if _, exists := r.grants[key]; exists {
		return errors.New("capability policy grant already exists")
	}
	r.grants[key] = grant
	return nil
}

func (r *PolicyResolver) Revoke(capability, target, symbol string) bool {
	key := policyKey{capability: capability, target: target, symbol: symbol}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.grants[key]; !exists {
		return false
	}
	delete(r.grants, key)
	return true
}

func (r *PolicyResolver) Resolve(_ context.Context, auth Authorization) (Grant, error) {
	if auth.Capability.Effect != ForeignCallEffect || !validCapabilityName(auth.Capability.Name) || auth.Target == "" || auth.Symbol == "" {
		return Grant{}, ErrCapabilityDenied
	}
	key := policyKey{capability: auth.Capability.Name, target: auth.Target, symbol: auth.Symbol}
	r.mu.RLock()
	grant, ok := r.grants[key]
	r.mu.RUnlock()
	if !ok || !grant.Valid() {
		return Grant{}, ErrCapabilityDenied
	}
	return grant, nil
}

type adapterKey struct {
	target     string
	symbol     string
	abi        string
	abiVersion string
}

type Adapter func(context.Context, Invocation) (WireValue, error)

// AdapterRegistry is an explicit trusted executor registry. It never loads
// guest-specified libraries. Invocation target/symbol/ABI must match an adapter
// registered by host code before execution.
type AdapterRegistry struct {
	mu       sync.RWMutex
	adapters map[adapterKey]Adapter
}

func NewAdapterRegistry() *AdapterRegistry {
	return &AdapterRegistry{adapters: map[adapterKey]Adapter{}}
}

func (r *AdapterRegistry) Register(target, symbol, abi, abiVersion string, adapter Adapter) error {
	if target == "" || symbol == "" || abi != "C" || abiVersion != "swyp-c64-v1" || adapter == nil {
		return errors.New("invalid foreign adapter registration")
	}
	key := adapterKey{target: target, symbol: symbol, abi: abi, abiVersion: abiVersion}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.adapters == nil {
		r.adapters = map[adapterKey]Adapter{}
	}
	if _, exists := r.adapters[key]; exists {
		return errors.New("foreign adapter already registered")
	}
	r.adapters[key] = adapter
	return nil
}

func (r *AdapterRegistry) Unregister(target, symbol, abi, abiVersion string) bool {
	key := adapterKey{target: target, symbol: symbol, abi: abi, abiVersion: abiVersion}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.adapters[key]; !exists {
		return false
	}
	delete(r.adapters, key)
	return true
}

func (r *AdapterRegistry) Execute(ctx context.Context, invocation Invocation) (WireValue, error) {
	if !invocation.Grant.Valid() {
		return WireValue{}, errors.New("foreign adapter invocation has no host grant")
	}
	key := adapterKey{target: invocation.Target, symbol: invocation.Symbol, abi: invocation.ABI, abiVersion: invocation.ABIVersion}
	r.mu.RLock()
	adapter := r.adapters[key]
	r.mu.RUnlock()
	if adapter == nil {
		return WireValue{}, errors.New("no trusted foreign adapter is registered")
	}
	return adapter(ctx, invocation)
}
