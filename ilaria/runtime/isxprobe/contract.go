// Package isxprobe authenticates synthetic peer envelopes, not compute or quality.
package isxprobe

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"ilaria/generated/myriad"
	"io"
	"time"
)

const MaxFrameBytes = 9 << 20
const NetworkFrameBytes = 256 << 10

// ValidateNetworkJob authenticates exact issuer-prepared canonical job bytes.
// It does not infer expected authorization from a candidate or prove compute.
func ValidateNetworkJob(signed []byte, signature string, public ed25519.PublicKey, expected []byte, now time.Time) error {
	if len(signed) > NetworkFrameBytes || len(expected) == 0 || !bytes.Equal(signed, expected) {
		return errors.New("network issued contract mismatch/size")
	}
	sig, e := hex.DecodeString(signature)
	if e != nil || len(public) != 32 || !ed25519.Verify(public, signed, sig) {
		return errors.New("pinned issuer signature")
	}
	var fields map[string]json.RawMessage
	if e = json.Unmarshal(signed, &fields); e != nil {
		return e
	}
	for _, key := range []string{"issuer_id", "expert_id", "session_id", "round_id", "genesis_checkpoint_hash", "current_parent_checkpoint_hash", "lineage_hash", "model_config_hash", "curriculum_manifest_hash", "dataset_scope", "authorized_purpose", "training_recipe_hash", "proposer_id", "evaluator_id", "proposer_key_hash", "evaluator_key_hash", "nonce"} {
		var value string
		if e = json.Unmarshal(fields[key], &value); e != nil || value == "" {
			return errors.New("missing network issued identity")
		}
	}
	var version, sequence, epoch, fence uint64
	var deadline int64
	_ = json.Unmarshal(fields["protocol_version"], &version)
	_ = json.Unmarshal(fields["round_sequence"], &sequence)
	_ = json.Unmarshal(fields["consent_epoch"], &epoch)
	_ = json.Unmarshal(fields["lease_fence"], &fence)
	_ = json.Unmarshal(fields["deadline_unix_ms"], &deadline)
	if version != 2 || sequence == 0 || epoch == 0 || fence == 0 || now.UnixMilli() >= deadline {
		return errors.New("network version/freshness")
	}
	return nil
}

type Bindings struct {
	Version                                                  uint64
	Expert                                                   string
	Peer, Round, Config, Base, Fixture, Recipe, Nonce, KeyID string
	Consent, Fence                                           uint64
	Deadline                                                 int64
}

func ValidateEnvelope(e myriad.IMCLocalProbeEnvelope, b Bindings, raw, public []byte, now time.Time) error {
	for _, value := range []string{b.Expert, b.Peer, b.Round, b.Config, b.Base, b.Fixture, b.Recipe, b.Nonce, b.KeyID} {
		if value == "" {
			return errors.New("incomplete issued binding")
		}
	}
	if b.Version != 1 || e.ExpertID != b.Expert {
		return errors.New("issued version/expert")
	}
	if b.Consent == 0 || b.Fence == 0 || b.Deadline <= 0 {
		return errors.New("incomplete issued binding")
	}
	if e.ProtocolVersion != 1 || e.PeerID != b.Peer || e.RoundID != b.Round || e.ModelConfigHash != b.Config ||
		e.GenesisCheckpointHash != b.Base || e.CurriculumManifestHash != b.Fixture || e.TrainingRecipeHash != b.Recipe ||
		e.Nonce != b.Nonce || e.SignerKeyID != b.KeyID || e.ConsentEpoch != b.Consent || e.LeaseFence != b.Fence ||
		e.DeadlineUnixMS != b.Deadline || now.UnixMilli() >= b.Deadline {
		return errors.New("unknown/stale binding")
	}
	if len(public) != ed25519.PublicKeySize || len(raw) > MaxFrameBytes || uint64(len(raw)) != e.PayloadBytes {
		return errors.New("key/size bound")
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(e.PayloadBase64)
	if err != nil || !bytes.Equal(payload, raw) {
		return errors.New("raw payload mismatch")
	}
	hash := sha256.Sum256(raw)
	if e.ParameterDeltaHash != hex.EncodeToString(hash[:]) {
		return errors.New("delta hash")
	}
	signed, err := base64.StdEncoding.Strict().DecodeString(e.SignedCanonicalBase64)
	if err != nil || len(signed) > MaxFrameBytes {
		return errors.New("signed bytes")
	}
	signature, err := hex.DecodeString(e.Signature)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(public), signed, signature) {
		return errors.New("peer signature")
	}
	unsigned := e
	unsigned.Signature = ""
	unsigned.SignedCanonicalBase64 = ""
	encoded, _ := json.Marshal(unsigned)
	var fields map[string]any
	d := json.NewDecoder(bytes.NewReader(encoded))
	d.UseNumber()
	if err = d.Decode(&fields); err != nil {
		return err
	}
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(fields); err != nil {
		return err
	}
	if !bytes.Equal(bytes.TrimSuffix(canonical.Bytes(), []byte("\n")), signed) {
		return errors.New("canonical metadata mismatch")
	}
	return nil
}

// Reject duplicate keys recursively before decoding a bounded typed envelope.
func unique(d *json.Decoder) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if delimiter == '{' {
		seen := map[string]bool{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			s, ok := key.(string)
			if !ok || seen[s] {
				return errors.New("duplicate key")
			}
			seen[s] = true
			if err = unique(d); err != nil {
				return err
			}
		}
	} else if delimiter == '[' {
		for d.More() {
			if err = unique(d); err != nil {
				return err
			}
		}
	} else {
		return errors.New("invalid JSON")
	}
	_, err = d.Token()
	return err
}
func DecodeStrict(frame []byte) (myriad.IMCLocalProbeEnvelope, error) {
	var e myriad.IMCLocalProbeEnvelope
	if len(frame) > MaxFrameBytes {
		return e, errors.New("oversize")
	}
	check := json.NewDecoder(bytes.NewReader(frame))
	if err := unique(check); err != nil {
		return e, err
	}
	if _, err := check.Token(); err != io.EOF {
		return e, errors.New("trailing JSON")
	}
	d := json.NewDecoder(bytes.NewReader(frame))
	d.DisallowUnknownFields()
	err := d.Decode(&e)
	return e, err
}
