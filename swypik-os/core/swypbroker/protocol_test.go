package swypbroker

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func interopPlanAndRequest(t *testing.T) (Plan, Request) {
	t.Helper()
	plan, err := ParsePlan(loadFixture(t, "swyp_scalar_plan_v1.json"))
	if err != nil {
		t.Fatalf("parse Swyp plan fixture: %v", err)
	}
	request, err := ParseRequest(loadFixture(t, "swyp_scalar_request_v1.json"))
	if err != nil {
		t.Fatalf("parse Swyp request fixture: %v", err)
	}
	if err := ValidateRequestAgainstPlan(request, plan); err != nil {
		t.Fatalf("Swyp request is not compatible with its plan: %v", err)
	}
	return plan, request
}

func TestSwypInteropFixturePreservesExactI64(t *testing.T) {
	plan, request := interopPlanAndRequest(t)
	if plan.PlanID != "sha256:8f5f6131f9e3c132ee7d95c1b801629e3d5355bfe6bf1179fa3e4fd51290cdef" {
		t.Fatalf("plan id changed: %s", plan.PlanID)
	}
	if request.RequestID != "sha256:0b962f5669a8488f00b2f92634e82726fb220060c3fbfbe2f75d912dec26cb99" {
		t.Fatalf("request id changed: %s", request.RequestID)
	}
	data, err := base64.StdEncoding.DecodeString(request.Arguments[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	if got := int64(binary.LittleEndian.Uint64(data)); got != 9007199254740994 {
		t.Fatalf("wire precision changed: %d", got)
	}
}

func TestStrictParsersRejectAuthorityMaterial(t *testing.T) {
	planData := string(loadFixture(t, "swyp_scalar_plan_v1.json"))
	planData = strings.Replace(planData, `"plan_id":`, `"grant_id":"secret","plan_id":`, 1)
	if _, err := ParsePlan([]byte(planData)); err == nil {
		t.Fatal("accepted grant_id in plan")
	}

	requestData := string(loadFixture(t, "swyp_scalar_request_v1.json"))
	requestData = strings.Replace(requestData, `"capability":`, `"authority_token":"secret","capability":`, 1)
	if _, err := ParseRequest([]byte(requestData)); err == nil {
		t.Fatal("accepted authority_token in request")
	}
}

func TestRequestFreshHashCannotChangeApprovedSymbol(t *testing.T) {
	plan, request := interopPlanAndRequest(t)
	request.Symbol = "attacker_symbol"
	id, err := requestContentID(request)
	if err != nil {
		t.Fatal(err)
	}
	request.RequestID = id
	if err := ValidateRequest(request); err != nil {
		t.Fatalf("self-consistent request rejected before plan binding: %v", err)
	}
	if err := ValidateRequestAgainstPlan(request, plan); err == nil {
		t.Fatal("approved plan accepted attacker-controlled symbol")
	}
}

func TestWireValidatorRejectsNonZeroStructPadding(t *testing.T) {
	typ := ABIType{
		Kind: "struct", Name: "Packet", Size: 16, Align: 8,
		Fields: []ABIField{
			{Name: "tag", Offset: 0, Type: ABIType{Kind: "bool", Size: 1, Align: 1}},
			{Name: "value", Offset: 8, Type: ABIType{Kind: "i64", Size: 8, Align: 8}},
		},
	}
	data := make([]byte, 16)
	data[0] = 1
	data[4] = 9
	binary.LittleEndian.PutUint64(data[8:], 7)
	value := WireValue{Type: typ, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(data)}
	if err := validateWireValue(value); err == nil {
		t.Fatal("accepted nonzero repr(C) padding")
	}
	data[4] = 0
	value.Data = base64.StdEncoding.EncodeToString(data)
	if err := validateWireValue(value); err != nil {
		t.Fatalf("valid zero-padded struct rejected: %v", err)
	}
}

func TestPlanIDIgnoresOnlyDiagnosticLocation(t *testing.T) {
	plan, _ := interopPlanAndRequest(t)
	plan.ForeignCalls[0].Location = Location{File: `E:\\other\\source.swyp`, Line: 99, Column: 12}
	id, err := planContentID(plan)
	if err != nil {
		t.Fatal(err)
	}
	if id != plan.PlanID {
		t.Fatalf("diagnostic path changed authority plan id: %s != %s", id, plan.PlanID)
	}
	plan.ForeignCalls[0].Symbol = "other"
	id, err = planContentID(plan)
	if err != nil {
		t.Fatal(err)
	}
	if id == plan.PlanID {
		t.Fatal("authority-relevant symbol did not change plan id")
	}
}

func TestResponseValidationMatchesRequestABI(t *testing.T) {
	_, request := interopPlanAndRequest(t)
	resultBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(resultBytes, 42)
	response := Response{
		Version: ProtocolVersion, RequestID: request.RequestID, Status: "ok",
		Result: &WireValue{Type: request.Result, Encoding: WireEncoding, Data: base64.StdEncoding.EncodeToString(resultBytes)},
	}
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseResponse(data, request); err != nil {
		t.Fatal(err)
	}
	response.Result.Type.Kind = "u64"
	data, _ = json.Marshal(response)
	if _, err := ParseResponse(data, request); err == nil {
		t.Fatal("accepted mismatched result ABI")
	}
}
