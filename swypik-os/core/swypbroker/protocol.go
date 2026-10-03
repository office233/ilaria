// Package swypbroker implements the Swyp -> SwypikOS foreign-call broker
// boundary. It deliberately depends only on the wire protocol: Swyp compiler
// internals and authority tokens never cross this package boundary.
package swypbroker

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

const (
	PlanVersion       = 1
	HIRVersion        = 1
	EffectVersion     = 1
	ProtocolVersion   = 1
	WireEncoding      = "swyp-c64-le-v1/base64"
	MaxMessageBytes   = 1 << 20
	ForeignCallEffect = "foreign.call"
)

type Type struct {
	Kind    string  `json:"kind"`
	Name    string  `json:"name,omitempty"`
	Element *Type   `json:"element,omitempty"`
	Ok      *Type   `json:"ok,omitempty"`
	Error   *Type   `json:"error,omitempty"`
	Length  *uint64 `json:"length,omitempty"`
}

type Location struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

type CapabilityRequirement struct {
	Name   string `json:"name"`
	Effect string `json:"effect"`
}

type ABIField struct {
	Name   string  `json:"name"`
	Offset uint64  `json:"offset"`
	Type   ABIType `json:"type"`
}

type ABIType struct {
	Kind    string     `json:"kind"`
	Name    string     `json:"name,omitempty"`
	Size    uint64     `json:"size"`
	Align   uint64     `json:"align"`
	Length  uint64     `json:"length,omitempty"`
	Element *ABIType   `json:"element,omitempty"`
	Fields  []ABIField `json:"fields,omitempty"`
}

type ForeignCall struct {
	CallID     string                `json:"call_id"`
	Caller     string                `json:"caller"`
	Target     string                `json:"target"`
	ABI        string                `json:"abi"`
	ABIVersion string                `json:"abi_version"`
	Symbol     string                `json:"symbol"`
	Effect     string                `json:"effect"`
	Capability CapabilityRequirement `json:"capability"`
	Params     []Type                `json:"params,omitempty"`
	Result     Type                  `json:"result"`
	ParamABI   []ABIType             `json:"param_abi,omitempty"`
	ResultABI  ABIType               `json:"result_abi"`
	Location   Location              `json:"location"`
}

type Plan struct {
	Version              int                     `json:"version"`
	PlanID               string                  `json:"plan_id,omitempty"`
	HIRVersion           int                     `json:"hir_version"`
	Entry                string                  `json:"entry"`
	EffectVersion        int                     `json:"effect_version,omitempty"`
	Effects              []string                `json:"effects,omitempty"`
	RequiredCapabilities []CapabilityRequirement `json:"required_capabilities,omitempty"`
	ForeignCalls         []ForeignCall           `json:"foreign_calls,omitempty"`
}

type WireValue struct {
	Type     ABIType `json:"type"`
	Encoding string  `json:"encoding"`
	Data     string  `json:"data"`
}

type Request struct {
	Version     int                   `json:"version"`
	RequestID   string                `json:"request_id,omitempty"`
	PlanVersion int                   `json:"plan_version"`
	PlanID      string                `json:"plan_id"`
	HIRVersion  int                   `json:"hir_version"`
	Entry       string                `json:"entry"`
	CallID      string                `json:"call_id"`
	Caller      string                `json:"caller"`
	Target      string                `json:"target"`
	ABI         string                `json:"abi"`
	ABIVersion  string                `json:"abi_version"`
	Symbol      string                `json:"symbol"`
	Effect      string                `json:"effect"`
	Capability  CapabilityRequirement `json:"capability"`
	Arguments   []WireValue           `json:"arguments,omitempty"`
	Result      ABIType               `json:"result"`
}

type ResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	Version   int            `json:"version"`
	RequestID string         `json:"request_id"`
	Status    string         `json:"status"`
	Result    *WireValue     `json:"result,omitempty"`
	Error     *ResponseError `json:"error,omitempty"`
}

func ParsePlan(data []byte) (Plan, error) {
	if len(data) > MaxMessageBytes {
		return Plan{}, fmt.Errorf("broker plan exceeds %d bytes", MaxMessageBytes)
	}
	var plan Plan
	if err := decodeStrict(data, &plan); err != nil {
		return Plan{}, err
	}
	if err := ValidatePlan(plan); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func ValidatePlan(plan Plan) error {
	if plan.Version != PlanVersion || plan.HIRVersion != HIRVersion || plan.Entry == "" {
		return errors.New("invalid broker plan identity/version")
	}
	if !validContentID(plan.PlanID) {
		return errors.New("invalid broker plan content id")
	}
	want, err := planContentID(plan)
	if err != nil {
		return err
	}
	if plan.PlanID != want {
		return errors.New("broker plan content id mismatch")
	}

	seenCalls := map[string]bool{}
	requiredCaps := map[CapabilityRequirement]bool{}
	previousCaller, previousID := "", ""
	for _, call := range plan.ForeignCalls {
		if call.CallID == "" || seenCalls[call.CallID] || call.Caller == "" || call.Target == "" || call.Symbol == "" {
			return fmt.Errorf("invalid or duplicate broker plan call id %q", call.CallID)
		}
		if previousCaller > call.Caller || (previousCaller == call.Caller && previousID >= call.CallID) {
			return errors.New("broker plan foreign calls are not in canonical order")
		}
		previousCaller, previousID = call.Caller, call.CallID
		seenCalls[call.CallID] = true
		if call.ABI != "C" || call.ABIVersion != "swyp-c64-v1" || call.Effect != ForeignCallEffect {
			return fmt.Errorf("unsupported foreign contract for call %s", call.CallID)
		}
		if call.Capability.Effect != ForeignCallEffect || !validCapabilityName(call.Capability.Name) {
			return fmt.Errorf("invalid logical capability for call %s", call.CallID)
		}
		requiredCaps[call.Capability] = true
		if len(call.ParamABI) != len(call.Params) {
			return fmt.Errorf("ABI arity mismatch for call %s", call.CallID)
		}
		for i, typ := range call.ParamABI {
			if err := validateABIType(typ, false); err != nil {
				return fmt.Errorf("call %s parameter %d ABI: %w", call.CallID, i, err)
			}
		}
		if err := validateABIType(call.ResultABI, true); err != nil {
			return fmt.Errorf("call %s result ABI: %w", call.CallID, err)
		}
	}

	if len(plan.ForeignCalls) == 0 {
		if plan.EffectVersion != 0 || len(plan.Effects) != 0 || len(plan.RequiredCapabilities) != 0 {
			return errors.New("pure broker plan cannot declare effects or capabilities")
		}
		return nil
	}
	if plan.EffectVersion != EffectVersion || len(plan.Effects) != 1 || plan.Effects[0] != ForeignCallEffect {
		return fmt.Errorf("effectful broker plan must declare exactly %s version %d", ForeignCallEffect, EffectVersion)
	}
	if len(plan.RequiredCapabilities) != len(requiredCaps) {
		return errors.New("broker plan capability set does not match reachable calls")
	}
	previousEffect, previousName := "", ""
	for _, capability := range plan.RequiredCapabilities {
		if !requiredCaps[capability] {
			return fmt.Errorf("unexpected broker capability %q", capability.Name)
		}
		if previousEffect > capability.Effect || (previousEffect == capability.Effect && previousName >= capability.Name) {
			return errors.New("broker plan capabilities are not in canonical order")
		}
		previousEffect, previousName = capability.Effect, capability.Name
	}
	return nil
}

func ParseRequest(data []byte) (Request, error) {
	if len(data) > MaxMessageBytes {
		return Request{}, fmt.Errorf("broker request exceeds %d bytes", MaxMessageBytes)
	}
	var request Request
	if err := decodeStrict(data, &request); err != nil {
		return Request{}, err
	}
	if err := ValidateRequest(request); err != nil {
		return Request{}, err
	}
	return request, nil
}

func ValidateRequest(request Request) error {
	if request.Version != ProtocolVersion || request.PlanVersion != PlanVersion || request.HIRVersion != HIRVersion {
		return errors.New("unsupported broker protocol/plan/HIR version")
	}
	if !validContentID(request.PlanID) || !validContentID(request.RequestID) {
		return errors.New("invalid broker request content id")
	}
	if request.Entry == "" || request.CallID == "" || request.Caller == "" || request.Target == "" || request.Symbol == "" {
		return errors.New("broker request identity is incomplete")
	}
	if request.ABI != "C" || request.ABIVersion != "swyp-c64-v1" || request.Effect != ForeignCallEffect {
		return errors.New("unsupported broker ABI/effect contract")
	}
	if request.Capability.Effect != ForeignCallEffect || !validCapabilityName(request.Capability.Name) {
		return errors.New("invalid logical capability requirement")
	}
	for i, argument := range request.Arguments {
		if err := validateWireValue(argument); err != nil {
			return fmt.Errorf("argument %d: %w", i, err)
		}
	}
	if err := validateABIType(request.Result, true); err != nil {
		return fmt.Errorf("result: %w", err)
	}
	want, err := requestContentID(request)
	if err != nil {
		return err
	}
	if request.RequestID != want {
		return errors.New("broker request content id mismatch")
	}
	return nil
}

func ValidateRequestAgainstPlan(request Request, plan Plan) error {
	if err := ValidatePlan(plan); err != nil {
		return err
	}
	if err := ValidateRequest(request); err != nil {
		return err
	}
	if request.PlanID != plan.PlanID || request.PlanVersion != plan.Version || request.HIRVersion != plan.HIRVersion || request.Entry != plan.Entry {
		return errors.New("broker request is not bound to this plan")
	}
	var site *ForeignCall
	for i := range plan.ForeignCalls {
		if plan.ForeignCalls[i].CallID == request.CallID {
			site = &plan.ForeignCalls[i]
			break
		}
	}
	if site == nil {
		return errors.New("broker request call id is not present in plan")
	}
	if request.Caller != site.Caller || request.Target != site.Target || request.ABI != site.ABI || request.ABIVersion != site.ABIVersion || request.Symbol != site.Symbol || request.Effect != site.Effect || request.Capability != site.Capability {
		return errors.New("broker request call contract does not match plan")
	}
	if len(request.Arguments) != len(site.ParamABI) {
		return errors.New("broker request argument count does not match plan")
	}
	for i := range request.Arguments {
		if !abiTypeEqual(request.Arguments[i].Type, site.ParamABI[i]) {
			return fmt.Errorf("broker request argument %d ABI does not match plan", i)
		}
	}
	if !abiTypeEqual(request.Result, site.ResultABI) {
		return errors.New("broker request result ABI does not match plan")
	}
	return nil
}

func ParseResponse(data []byte, request Request) (Response, error) {
	if len(data) > MaxMessageBytes {
		return Response{}, fmt.Errorf("broker response exceeds %d bytes", MaxMessageBytes)
	}
	var response Response
	if err := decodeStrict(data, &response); err != nil {
		return Response{}, err
	}
	if response.Version != ProtocolVersion || response.RequestID != request.RequestID {
		return Response{}, errors.New("broker response identity/version mismatch")
	}
	switch response.Status {
	case "ok":
		if response.Error != nil {
			return Response{}, errors.New("successful broker response cannot contain an error")
		}
		if request.Result.Kind == "void" {
			if response.Result != nil {
				return Response{}, errors.New("void broker response cannot contain a result")
			}
			return response, nil
		}
		if response.Result == nil || !abiTypeEqual(response.Result.Type, request.Result) {
			return Response{}, errors.New("broker response result ABI does not match request")
		}
		if err := validateWireValue(*response.Result); err != nil {
			return Response{}, fmt.Errorf("broker response result: %w", err)
		}
	case "denied", "error":
		if response.Result != nil || response.Error == nil || response.Error.Code == "" || response.Error.Message == "" {
			return Response{}, errors.New("failed broker response requires error details and no result")
		}
	default:
		return Response{}, fmt.Errorf("unknown broker response status %q", response.Status)
	}
	return response, nil
}

func validateWireValue(value WireValue) error {
	if value.Encoding != WireEncoding {
		return fmt.Errorf("unsupported broker wire encoding %q", value.Encoding)
	}
	if err := validateABIType(value.Type, false); err != nil {
		return err
	}
	data, err := base64.StdEncoding.Strict().DecodeString(value.Data)
	if err != nil {
		return errors.New("invalid base64 data")
	}
	if uint64(len(data)) != value.Type.Size {
		return fmt.Errorf("wire size %d does not match ABI size %d", len(data), value.Type.Size)
	}
	return validateWireBytes(value.Type, data)
}

func validateWireBytes(typ ABIType, data []byte) error {
	switch typ.Kind {
	case "bool":
		if len(data) != 1 || data[0] > 1 {
			return errors.New("invalid bool wire value")
		}
	case "f64":
		bits := uint64(0)
		for i := 0; i < 8; i++ {
			bits |= uint64(data[i]) << (8 * i)
		}
		value := math.Float64frombits(bits)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return errors.New("f64 wire value must be finite")
		}
	case "array":
		if typ.Element == nil {
			return errors.New("array wire descriptor has no element")
		}
		for i := uint64(0); i < typ.Length; i++ {
			start := i * typ.Element.Size
			if err := validateWireBytes(*typ.Element, data[start:start+typ.Element.Size]); err != nil {
				return fmt.Errorf("array[%d]: %w", i, err)
			}
		}
	case "struct":
		covered := make([]bool, len(data))
		for _, field := range typ.Fields {
			start := field.Offset
			end := start + field.Type.Size
			if err := validateWireBytes(field.Type, data[start:end]); err != nil {
				return fmt.Errorf("struct %s.%s: %w", typ.Name, field.Name, err)
			}
			for i := start; i < end; i++ {
				covered[i] = true
			}
		}
		for i, used := range covered {
			if !used && data[i] != 0 {
				return fmt.Errorf("struct %s has nonzero padding at byte %d", typ.Name, i)
			}
		}
	}
	return nil
}

func validateABIType(typ ABIType, allowVoid bool) error {
	if typ.Size > MaxMessageBytes {
		return errors.New("ABI value exceeds broker message limit")
	}
	switch typ.Kind {
	case "void":
		if !allowVoid || typ.Size != 0 || typ.Align != 1 || typ.Name != "" || typ.Element != nil || len(typ.Fields) != 0 || typ.Length != 0 {
			return errors.New("invalid void ABI descriptor")
		}
	case "bool":
		if typ.Size != 1 || typ.Align != 1 || typ.Name != "" || typ.Element != nil || len(typ.Fields) != 0 || typ.Length != 0 {
			return errors.New("invalid bool ABI descriptor")
		}
	case "i64", "u64", "f64", "ieee64":
		if typ.Size != 8 || typ.Align != 8 || typ.Name != "" || typ.Element != nil || len(typ.Fields) != 0 || typ.Length != 0 {
			return fmt.Errorf("invalid %s ABI descriptor", typ.Kind)
		}
	case "array":
		if typ.Element == nil || typ.Align == 0 || typ.Align != typ.Element.Align || typ.Name != "" || len(typ.Fields) != 0 {
			return errors.New("invalid array ABI descriptor")
		}
		if err := validateABIType(*typ.Element, false); err != nil {
			return err
		}
		if typ.Length != 0 && typ.Element.Size > math.MaxUint64/typ.Length {
			return errors.New("array ABI size overflow")
		}
		if typ.Size != typ.Element.Size*typ.Length {
			return errors.New("array ABI size mismatch")
		}
	case "struct":
		if typ.Name == "" || !isPowerOfTwo(typ.Align) || typ.Size%typ.Align != 0 || typ.Element != nil || typ.Length != 0 {
			return errors.New("invalid struct ABI descriptor")
		}
		seen := map[string]bool{}
		lastEnd := uint64(0)
		for _, field := range typ.Fields {
			if field.Name == "" || seen[field.Name] {
				return fmt.Errorf("invalid or duplicate struct ABI field %q", field.Name)
			}
			seen[field.Name] = true
			if err := validateABIType(field.Type, false); err != nil {
				return fmt.Errorf("field %s: %w", field.Name, err)
			}
			if field.Offset%field.Type.Align != 0 || field.Offset < lastEnd || field.Offset > typ.Size || field.Type.Size > typ.Size-field.Offset {
				return fmt.Errorf("invalid layout for struct field %s", field.Name)
			}
			lastEnd = field.Offset + field.Type.Size
		}
	default:
		return fmt.Errorf("unsupported broker ABI kind %q", typ.Kind)
	}
	return nil
}

func planContentID(plan Plan) (string, error) {
	copyPlan := plan
	copyPlan.PlanID = ""
	copyPlan.ForeignCalls = append([]ForeignCall(nil), plan.ForeignCalls...)
	for i := range copyPlan.ForeignCalls {
		copyPlan.ForeignCalls[i].Location = Location{}
	}
	data, err := json.Marshal(copyPlan)
	if err != nil {
		return "", err
	}
	return sha256ID(data), nil
}

func requestContentID(request Request) (string, error) {
	copyRequest := request
	copyRequest.RequestID = ""
	data, err := json.Marshal(copyRequest)
	if err != nil {
		return "", err
	}
	return sha256ID(data), nil
}

func sha256ID(data []byte) string {
	digest := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func validContentID(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(value[len("sha256:"):])
	return err == nil
}

func validCapabilityName(name string) bool {
	if len(name) < 1 || len(name) > 64 || name[0] < 'a' || name[0] > 'z' {
		return false
	}
	for i := 1; i < len(name); i++ {
		c := name[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

func abiTypeEqual(a, b ABIType) bool {
	left, errLeft := json.Marshal(a)
	right, errRight := json.Marshal(b)
	return errLeft == nil && errRight == nil && bytes.Equal(left, right)
}

func decodeStrict(data []byte, target any) error {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func isPowerOfTwo(value uint64) bool { return value != 0 && value&(value-1) == 0 }
