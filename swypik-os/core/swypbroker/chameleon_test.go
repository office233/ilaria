package swypbroker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"swypik-os/core/chameleon"
	"swypik-os/core/controlkernel"
)

func mmioPlanRequest(t *testing.T) (Plan, Request) {
	t.Helper()
	plan, err := ParsePlan(loadFixture(t, "swyp_mmio_plan_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	request, err := ParseRequest(loadFixture(t, "swyp_mmio_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRequestAgainstPlan(request, plan); err != nil {
		t.Fatal(err)
	}
	return plan, request
}

func TestChameleonMMIOResolverMintsHostOnlyScopedToken(t *testing.T) {
	controller := chameleon.NewHardwareController([]byte("swypbroker-chameleon-test-secret"))
	resolver, err := NewChameleonMMIOResolver(controller, []uint32{chameleon.AddrCoolingDuty}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	auth := Authorization{Target: ChameleonMMIOTarget, Symbol: ChameleonMMIOSymbol, Capability: CapabilityRequirement{Name: ChameleonMMIOCapability, Effect: ForeignCallEffect}}
	grant, err := resolver.Resolve(context.Background(), auth)
	if err != nil || !grant.Valid() {
		t.Fatalf("grant=%+v err=%v", grant, err)
	}
	internal, ok := grant.Value().(chameleonMMIOGrant)
	if !ok || !controller.VerifyCapability(internal.token, chameleon.AddrCoolingDuty, true) {
		t.Fatal("resolver did not mint a valid scoped Chameleon token")
	}
	if controller.VerifyCapability(internal.token, chameleon.AddrActuationTorque, true) {
		t.Fatal("Chameleon token unexpectedly authorizes another register")
	}
	auth.Symbol = "attacker_symbol"
	if _, err := resolver.Resolve(context.Background(), auth); err != ErrCapabilityDenied {
		t.Fatalf("wrong symbol resolve error=%v", err)
	}
}

func TestChameleonMMIOAdapterExecutesOnlyAuthorizedRegister(t *testing.T) {
	_, request := mmioPlanRequest(t)
	controller := chameleon.NewHardwareController([]byte("swypbroker-chameleon-adapter-secret"))
	resolver, err := NewChameleonMMIOResolver(controller, []uint32{chameleon.AddrCoolingDuty}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := resolver.Resolve(context.Background(), Authorization{Target: request.Target, Symbol: request.Symbol, Capability: request.Capability})
	if err != nil {
		t.Fatal(err)
	}
	registry := NewAdapterRegistry()
	if err := RegisterChameleonMMIOAdapter(registry); err != nil {
		t.Fatal(err)
	}
	result, err := registry.Execute(context.Background(), Invocation{
		ExecutionID: "exec-mmio", PlanID: request.PlanID, RequestID: request.RequestID, CallID: request.CallID,
		Caller: request.Caller, Target: request.Target, ABI: request.ABI, ABIVersion: request.ABIVersion,
		Symbol: request.Symbol, Capability: request.Capability, Arguments: request.Arguments, Result: request.Result, Grant: grant,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Type.Kind != "" || controller.ReadMMIO(chameleon.AddrCoolingDuty) != 55 {
		t.Fatalf("result=%+v cooling=%d", result, controller.ReadMMIO(chameleon.AddrCoolingDuty))
	}
}

func TestChameleonMMIOEndToEndThroughControlKernel(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	plan, _ := mmioPlanRequest(t)
	plans := NewRegistry()
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plans.ApproveJSON(data); err != nil {
		t.Fatal(err)
	}
	controller := chameleon.NewHardwareController([]byte("swypbroker-chameleon-kernel-secret"))
	resolver, err := NewChameleonMMIOResolver(controller, []uint32{chameleon.AddrCoolingDuty}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	adapters := NewAdapterRegistry()
	if err := RegisterChameleonMMIOAdapter(adapters); err != nil {
		t.Fatal(err)
	}
	broker, err := New(plans, resolver, adapters)
	if err != nil {
		t.Fatal(err)
	}
	kernelBroker, err := NewKernelBroker(kernel, broker)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := kernelBroker.Prepare("exec-mmio-kernel", "node", token, loadFixture(t, "swyp_mmio_request_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	response, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "ok" || response.Result != nil {
		t.Fatalf("response=%+v", response)
	}
	if got := controller.ReadMMIO(chameleon.AddrCoolingDuty); got != 55 {
		t.Fatalf("cooling register=%d", got)
	}
	intent, ok := kernel.IntentByKey("swyp-broker:exec-mmio-kernel")
	if !ok || intent.State != controlkernel.IntentResult {
		t.Fatalf("intent=%+v", intent)
	}
}

func TestChameleonMMIOFailureBecomesUncertainAfterStart(t *testing.T) {
	kernel, token := openBrokerKernel(t)
	plan, request := mmioPlanRequest(t)
	request.Arguments[0].Data = "BBAAAAAAAAA=" // 0x1004, not authorized by resolver token.
	id, err := requestContentID(request)
	if err != nil {
		t.Fatal(err)
	}
	request.RequestID = id
	rawRequest, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	plans := NewRegistry()
	planData, _ := json.Marshal(plan)
	if _, err := plans.ApproveJSON(planData); err != nil {
		t.Fatal(err)
	}
	controller := chameleon.NewHardwareController([]byte("swypbroker-chameleon-deny-secret"))
	resolver, _ := NewChameleonMMIOResolver(controller, []uint32{chameleon.AddrCoolingDuty}, time.Minute)
	adapters := NewAdapterRegistry()
	if err := RegisterChameleonMMIOAdapter(adapters); err != nil {
		t.Fatal(err)
	}
	broker, _ := New(plans, resolver, adapters)
	kernelBroker, _ := NewKernelBroker(kernel, broker)
	prepared, err := kernelBroker.Prepare("exec-mmio-unauthorized", "node", token, rawRequest)
	if err != nil {
		t.Fatal(err)
	}
	if err := kernel.TransitionNode("node", controlkernel.NodeExecuting, token); err != nil {
		t.Fatal(err)
	}
	response, err := kernelBroker.ExecutePrepared(context.Background(), prepared, token)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "error" || response.Error == nil || response.Error.Code != "executor_error" {
		t.Fatalf("response=%+v", response)
	}
	intent, _ := kernel.IntentByKey("swyp-broker:exec-mmio-unauthorized")
	if intent.State != controlkernel.IntentUncertain {
		t.Fatalf("intent state=%s", intent.State)
	}
	if controller.ReadMMIO(chameleon.AddrActuationTorque) != 0 {
		t.Fatal("unauthorized register was modified")
	}
}
