package swypbroker

import (
	"encoding/json"
	"sync"
)

// Registry stores only pre-approved broker plans. The stored representation is
// immutable canonical JSON so callers cannot mutate authority policy via shared
// slices after approval.
type Registry struct {
	mu    sync.RWMutex
	plans map[string][]byte
}

func NewRegistry() *Registry {
	return &Registry{plans: map[string][]byte{}}
}

func (r *Registry) ApproveJSON(data []byte) (Plan, error) {
	plan, err := ParsePlan(data)
	if err != nil {
		return Plan{}, err
	}
	if err := r.Approve(plan); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func (r *Registry) Approve(plan Plan) error {
	if err := ValidatePlan(plan); err != nil {
		return err
	}
	canonical, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.plans == nil {
		r.plans = map[string][]byte{}
	}
	if _, exists := r.plans[plan.PlanID]; !exists {
		r.plans[plan.PlanID] = append([]byte(nil), canonical...)
	}
	return nil
}

func (r *Registry) Lookup(planID string) (Plan, bool) {
	r.mu.RLock()
	data, ok := r.plans[planID]
	data = append([]byte(nil), data...)
	r.mu.RUnlock()
	if !ok {
		return Plan{}, false
	}
	plan, err := ParsePlan(data)
	if err != nil {
		return Plan{}, false
	}
	return plan, true
}

func (r *Registry) Revoke(planID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.plans[planID]; !ok {
		return false
	}
	delete(r.plans, planID)
	return true
}

func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.plans)
}
